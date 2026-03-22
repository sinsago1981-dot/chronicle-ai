import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { gameSessions, storyEntries } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import OpenAI from "openai";

const router: IRouter = Router();

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
  ...(process.env.AI_INTEGRATIONS_OPENAI_BASE_URL
    ? { baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL }
    : {}),
});

// ─── Types ────────────────────────────────────────────────────────────────────

type Stats = {
  hp: number; maxHp: number; strength: number;
  cunning: number; will: number; reputation: number;
};
type StatChanges = { hp?: number; strength?: number; cunning?: number; will?: number; reputation?: number };
type DiceOutcome = "critical_failure" | "failure" | "partial" | "success" | "critical_success";
type RollResult = { raw: number; stat: string; statValue: number; modifier: number; total: number; outcome: DiceOutcome };

type SkillType = "combat" | "survival" | "utility" | "social";

type Skill = {
  id: string; name: string; nameKo: string;
  description: string; descriptionKo: string;
  skillType: SkillType;
  statBonus: keyof Omit<Stats, "hp" | "maxHp">;
  bonusValue: number; hpEffect?: number;
  cooldown: number; currentCooldown: number;
  statRequirement?: { stat: keyof Omit<Stats, "hp" | "maxHp">; min: number };
};

type Enemy = { name: string; nameKo?: string; hp: number; maxHp: number; attack: number; defense: number };

type ItemType   = "consumable" | "equipment" | "key_item";
type ItemRarity = "common" | "uncommon" | "rare" | "legendary";
type ItemEffect = { hp?: number; strength?: number; cunning?: number; will?: number; reputation?: number };
type Item = {
  id: string; name: string; nameKo: string;
  description: string; descriptionKo: string;
  type: ItemType; rarity: ItemRarity; icon: string;
  effect: ItemEffect;
  equipped?: boolean; quantity: number;
  situational?: boolean; condition?: string;
};

type PlayerMeta = {
  name: string;
  characterClass: string;
  skills: Skill[];
  goal: string;
  goalShort: string;
};

// ─── In-memory state ──────────────────────────────────────────────────────────

const statsMap              = new Map<number, Stats>();
const enemyMap              = new Map<number, Enemy | null>();
const playerMetas           = new Map<number, PlayerMeta>();
const inventoryMap          = new Map<number, Item[]>();
const worldEventsMap        = new Map<number, string[]>();
const pendingKeyItemsMap    = new Map<number, string[]>(); // itemIds offered last turn

const MAX_WORLD_EVENTS = 25;

function addWorldEvents(sessionId: number, events: string[], turn: number): void {
  const existing = worldEventsMap.get(sessionId) ?? [];
  const stamped  = events.map(e => `[Turn ${turn}] ${e}`);
  const merged   = [...existing, ...stamped].slice(-MAX_WORLD_EVENTS);
  worldEventsMap.set(sessionId, merged);
}

function buildWorldMemoryBlock(sessionId: number, lang: string): string {
  const events = worldEventsMap.get(sessionId) ?? [];
  if (events.length === 0) return "";
  const header = lang === "ko"
    ? "세계 기록 — 영구적 결과를 가진 행동들:"
    : "WORLD MEMORY — actions with lasting consequences:";
  const footer = lang === "ko"
    ? "이 기록을 반드시 반영하세요. NPC들은 플레이어의 과거를 기억합니다."
    : "Honor these. NPCs and factions remember the player's past.";
  return `\n\n${header}\n${events.map(e => `• ${e}`).join("\n")}\n${footer}`;
}

function reconstructWorldEvents(entries: Array<{ entryType: string; content: string }>): string[] {
  const events: string[] = [];
  let turn = 0;
  for (const entry of entries) {
    if (entry.entryType === "choice") turn++;
    if (entry.entryType === "narration") {
      try {
        const data = JSON.parse(entry.content);
        if (Array.isArray(data.worldEvents) && data.worldEvents.length > 0) {
          for (const e of data.worldEvents) {
            events.push(`[Turn ${turn}] ${e}`);
          }
        }
      } catch { /* ignore */ }
    }
  }
  return events.slice(-MAX_WORLD_EVENTS);
}

// ─── Safe JSON parsing (handles markdown fences from LLM) ────────────────────
function safeParseJSON(raw: string): Record<string, unknown> {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    return JSON.parse(cleaned);
  } catch {
    return {};
  }
}

// ─── In-flight guard (prevents duplicate concurrent requests per session) ─────
const inFlightSessions = new Set<number>();

function applyEquipmentBonuses(base: Stats, inventory: Item[]): Stats {
  const equipped = inventory.filter(i => i.type === "equipment" && i.equipped);
  if (equipped.length === 0) return base;
  const r = { ...base };
  for (const item of equipped) {
    if (item.effect.strength)   r.strength   = Math.min(10, r.strength   + item.effect.strength);
    if (item.effect.cunning)    r.cunning    = Math.min(10, r.cunning    + item.effect.cunning);
    if (item.effect.will)       r.will       = Math.min(10, r.will       + item.effect.will);
    if (item.effect.reputation) r.reputation = Math.min(10, r.reputation + item.effect.reputation);
    // HP is not modified by equipment — use consumables for HP effects
  }
  return r;
}

function mergeItems(existing: Item[], gained: Item[]): Item[] {
  const result = [...existing];
  for (const newItem of gained) {
    const idx = result.findIndex(i => i.id === newItem.id);
    if (idx !== -1 && newItem.type === "consumable") {
      result[idx] = { ...result[idx], quantity: result[idx].quantity + (newItem.quantity ?? 1) };
    } else if (idx === -1) {
      result.push({ ...newItem, equipped: false, quantity: newItem.quantity ?? 1 });
    }
  }
  return result;
}

// ─── Skills per class ─────────────────────────────────────────────────────────
// Each class has 6 skills (mix of combat / survival / utility / social types).
// statRequirement: if the starting stat is below min, the skill is locked.

const CLASS_SKILLS: Record<string, Skill[]> = {
  Warrior: [
    { id: "battle_cry",         skillType: "combat",   name: "Battle Cry",          nameKo: "전투의 함성",     description: "A fearsome war cry stuns the enemy and lets you strike unopposed.",                        descriptionKo: "두려운 함성이 적을 기절시키고 반격 없이 공격하게 한다.",                 statBonus: "strength",   bonusValue: 0,              cooldown: 3, currentCooldown: 0 },
    { id: "berserker_rage",     skillType: "combat",   name: "Berserker Rage",      nameKo: "광전사의 분노",   description: "Reckless, devastating strikes. Massive damage — but pain is the cost.",                     descriptionKo: "무모하고 파괴적인 일격. 막대한 피해 — 대신 자신도 다친다.",              statBonus: "strength",   bonusValue: 0, hpEffect: -8, cooldown: 3, currentCooldown: 0, statRequirement: { stat: "strength",   min: 7 } },
    { id: "iron_skin",          skillType: "survival", name: "Iron Skin",           nameKo: "강철 피부",       description: "Harden your body against punishment. Heal and avoid retaliation.",                         descriptionKo: "몸을 단련해 징벌을 견뎌낸다. 체력 회복 후 반격을 피한다.",               statBonus: "strength",   bonusValue: 1, hpEffect: 15, cooldown: 3, currentCooldown: 0 },
    { id: "last_stand",         skillType: "survival", name: "Last Stand",          nameKo: "최후의 저항",     description: "Near death, your will surges. Wounds close. Resolve hardens. +20 HP.",                     descriptionKo: "죽음 직전 의지가 치솟는다. 상처가 닫힌다. HP +20.",                      statBonus: "will",       bonusValue: 2, hpEffect: 20, cooldown: 4, currentCooldown: 0, statRequirement: { stat: "will",       min: 7 } },
    { id: "soldier_instinct",   skillType: "utility",  name: "Soldier's Instinct",  nameKo: "병사의 본능",     description: "Read the battlefield perfectly — expose weak points, avoid retaliation.",                  descriptionKo: "전장을 완벽하게 읽는다 — 약점을 드러내고 반격을 완전히 피한다.",         statBonus: "cunning",    bonusValue: 0,              cooldown: 2, currentCooldown: 0 },
    { id: "warlord_presence",   skillType: "social",   name: "Warlord's Presence",  nameKo: "군주의 존재감",   description: "Your presence weakens enemy resolve and reflects their aggression back.",                   descriptionKo: "당신의 존재가 적의 의지를 꺾고 그들의 공격성을 반사시킨다.",              statBonus: "reputation", bonusValue: 0,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "reputation", min: 5 } },
  ],
  Rogue: [
    { id: "shadow_strike",      skillType: "combat",   name: "Shadow Strike",       nameKo: "그림자 일격",     description: "Strike from an unseen angle. Heavy damage, causes bleeding, no retaliation.",              descriptionKo: "보이지 않는 각도에서 공격. 큰 피해, 출혈 유발, 반격 없음.",              statBonus: "cunning",    bonusValue: 0,              cooldown: 3, currentCooldown: 0 },
    { id: "smoke_bomb",         skillType: "combat",   name: "Smoke Bomb",          nameKo: "연막탄",          description: "Poison gas smoke bomb — stuns and poisons the enemy while you vanish.",                   descriptionKo: "독가스 연막탄 — 적을 기절·중독시키며 반격 없이 사라진다.",               statBonus: "cunning",    bonusValue: 0,              cooldown: 2, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 6 } },
    { id: "vanish",             skillType: "survival", name: "Vanish",              nameKo: "잠적",            description: "Disappear completely. Heals as you escape danger. +8 HP, no retaliation.",               descriptionKo: "완전히 사라진다. 위험에서 벗어나며 치유된다. HP +8, 반격 없음.",         statBonus: "cunning",    bonusValue: 2, hpEffect: 8,  cooldown: 3, currentCooldown: 0 },
    { id: "street_tough",       skillType: "survival", name: "Street Tough",        nameKo: "길거리 강인함",   description: "A lifetime of hard knocks. Shrug it off and keep fighting. +12 HP.",                       descriptionKo: "거친 삶이 강인함을 남겼다. 툭툭 털고 계속 싸운다. HP +12.",              statBonus: "strength",   bonusValue: 2, hpEffect: 12, cooldown: 3, currentCooldown: 0, statRequirement: { stat: "strength",   min: 6 } },
    { id: "lockpick",           skillType: "utility",  name: "Lockpick",            nameKo: "자물쇠 따기",     description: "Find and exploit armor gaps. Permanently reduces enemy defense, no retaliation.",          descriptionKo: "적 방어구의 빈틈을 찾아 활용. 방어력을 영구히 감소시키고 반격 없음.",   statBonus: "cunning",    bonusValue: 0,              cooldown: 2, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 7 } },
    { id: "silver_tongue",      skillType: "social",   name: "Silver Tongue",       nameKo: "은빛 혀",         description: "Talk the enemy into hesitation. Weakens their combat effectiveness for 3 turns.",          descriptionKo: "적을 망설임에 빠뜨린다. 3턴간 전투 효율을 약화시키고 반격 없음.",       statBonus: "reputation", bonusValue: 0,              cooldown: 3, currentCooldown: 0 },
  ],
  Mage: [
    { id: "arcane_surge",       skillType: "combat",   name: "Arcane Surge",        nameKo: "비전 쇄도",       description: "Raw magical energy as a burning blast. High damage with fire damage over time.",           descriptionKo: "원초적 마법 에너지가 불타는 폭발로. 높은 피해와 지속 화상.",             statBonus: "will",       bonusValue: 0,              cooldown: 3, currentCooldown: 0 },
    { id: "chain_lightning",    skillType: "combat",   name: "Chain Lightning",     nameKo: "연쇄 번개",       description: "Lightning arcs between targets. Massive damage and stuns the enemy.",                      descriptionKo: "번개가 대상들 사이를 튄다. 막대한 피해와 기절.",                         statBonus: "will",       bonusValue: 0,              cooldown: 4, currentCooldown: 0, statRequirement: { stat: "will",       min: 8 } },
    { id: "mana_shield",        skillType: "survival", name: "Mana Shield",         nameKo: "마나 방어막",     description: "Arcane energy wraps you. Heals and reflects incoming damage. +10 HP.",                     descriptionKo: "비전 에너지로 자신을 감싼다. 치유하고 피해를 반사한다. HP +10.",          statBonus: "will",       bonusValue: 2, hpEffect: 10, cooldown: 3, currentCooldown: 0 },
    { id: "spell_recovery",     skillType: "survival", name: "Spell Recovery",      nameKo: "주문 회복",       description: "Redirect spell energy inward. Full focus restoration. +18 HP, no retaliation.",           descriptionKo: "주문 에너지를 내부로 돌린다. 완전 집중 회복. HP +18, 반격 없음.",        statBonus: "will",       bonusValue: 1, hpEffect: 18, cooldown: 4, currentCooldown: 0, statRequirement: { stat: "will",       min: 9 } },
    { id: "arcane_sight",       skillType: "utility",  name: "Arcane Sight",        nameKo: "마법 시야",       description: "Magically expose structural weaknesses. Reduces enemy armor permanently.",                 descriptionKo: "마법으로 구조적 약점 노출. 반격 없이 적의 방어를 영구히 감소.",           statBonus: "cunning",    bonusValue: 0,              cooldown: 2, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 6 } },
    { id: "enchanting_words",   skillType: "social",   name: "Enchanting Words",    nameKo: "마혹의 말",       description: "Weave subtle compulsion into combat. Weakens enemy for 3 turns, no retaliation.",          descriptionKo: "은밀한 강요를 전투에 엮는다. 3턴간 적을 약화, 반격 없음.",               statBonus: "reputation", bonusValue: 0,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "reputation", min: 6 } },
  ],
  Paladin: [
    { id: "holy_strike",        skillType: "combat",   name: "Holy Strike",         nameKo: "성스러운 일격",   description: "Divine light burns through the blow. Heavy damage and ignites holy fire.",                  descriptionKo: "신성한 빛이 일격을 불태운다. 큰 피해와 신성한 화상.",                    statBonus: "will",       bonusValue: 0,              cooldown: 3, currentCooldown: 0 },
    { id: "divine_smite",       skillType: "combat",   name: "Divine Smite",        nameKo: "신성한 강타",     description: "All divine wrath into one devastating blow. Highest single hit damage.",                   descriptionKo: "모든 신성한 분노를 단 한 번의 파괴적인 일격에. 최강 단일 타격.",          statBonus: "will",       bonusValue: 0,              cooldown: 4, currentCooldown: 0, statRequirement: { stat: "will",       min: 8 } },
    { id: "lay_on_hands",       skillType: "survival", name: "Lay on Hands",        nameKo: "안수",            description: "Channel holy energy through faith alone. Massive healing. +22 HP.",                       descriptionKo: "순수한 신앙으로 성스러운 에너지를 모아 상처를 치유한다. HP +22.",         statBonus: "will",       bonusValue: 1, hpEffect: 22, cooldown: 4, currentCooldown: 0 },
    { id: "divine_protection",  skillType: "survival", name: "Divine Protection",   nameKo: "신성한 보호",     description: "Holy ward absorbs and reflects damage. +15 HP, retaliation reflected.",                    descriptionKo: "신성한 결계가 피해를 흡수하고 반사한다. HP +15, 반격 반사.",             statBonus: "will",       bonusValue: 2, hpEffect: 15, cooldown: 3, currentCooldown: 0, statRequirement: { stat: "will",       min: 9 } },
    { id: "judgement",          skillType: "utility",  name: "Judgement",           nameKo: "심판",            description: "Strip enemy defenses — permanently reduce their armor and weaken their power.",           descriptionKo: "적의 방어를 벗겨낸다 — 갑옷을 영구히 줄이고 전투력을 약화.",            statBonus: "cunning",    bonusValue: 0,              cooldown: 2, currentCooldown: 0, statRequirement: { stat: "strength",   min: 7 } },
    { id: "blessed_presence",   skillType: "social",   name: "Blessed Presence",    nameKo: "축복받은 존재",   description: "A divine shield absorbs and reflects incoming damage. No retaliation.",                     descriptionKo: "신성한 방패가 들어오는 피해를 흡수하고 반사한다. 반격 없음.",             statBonus: "reputation", bonusValue: 0,              cooldown: 3, currentCooldown: 0 },
  ],
  Ranger: [
    { id: "precision_shot",     skillType: "combat",   name: "Precision Shot",      nameKo: "정밀 사격",       description: "A carefully aimed shot that pierces armor and causes prolonged bleeding.",                 descriptionKo: "방어구를 관통하고 지속적인 출혈을 유발하는 정밀 조준 사격.",              statBonus: "cunning",    bonusValue: 0,              cooldown: 3, currentCooldown: 0 },
    { id: "volley",             skillType: "combat",   name: "Volley",              nameKo: "일제 사격",       description: "Rapid arrow burst — solid damage with bleeding on multiple impacts.",                     descriptionKo: "신속한 화살 연사 — 여러 충격으로 피해와 출혈.",                           statBonus: "cunning",    bonusValue: 0,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 6 } },
    { id: "beast_bond",         skillType: "combat",   name: "Beast Bond",          nameKo: "야수의 유대",     description: "A beast companion flanks the enemy — deal damage without taking retaliation.",            descriptionKo: "야수 동료가 측면을 노린다 — 반격 없이 피해를 가한다.",                   statBonus: "cunning",    bonusValue: 0,              cooldown: 2, currentCooldown: 0 },
    { id: "camouflage",         skillType: "survival", name: "Camouflage",          nameKo: "위장",            description: "Vanish into terrain, heal wounds in safety. +8 HP, no retaliation.",                      descriptionKo: "지형에 숨어 안전하게 상처를 치유한다. HP +8, 반격 없음.",                 statBonus: "cunning",    bonusValue: 2, hpEffect: 8,  cooldown: 3, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 7 } },
    { id: "trackmaster",        skillType: "utility",  name: "Trackmaster",         nameKo: "추적 전문가",     description: "Read enemy movement patterns. Avoid retaliation, permanently lower enemy defense.",        descriptionKo: "적의 움직임 패턴을 읽는다. 반격을 피하고 방어를 영구적으로 감소.",        statBonus: "cunning",    bonusValue: 0,              cooldown: 2, currentCooldown: 0 },
    { id: "hunters_mark",       skillType: "social",   name: "Hunter's Mark",       nameKo: "사냥꾼의 낙인",   description: "Mark the prey — cuts through armor and causes festering decay.",                           descriptionKo: "먹잇감을 낙인찍는다 — 갑옷을 뚫고 부패를 유발한다.",                     statBonus: "reputation", bonusValue: 0,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "reputation", min: 6 } },
  ],
  Necromancer: [
    { id: "soul_drain",         skillType: "combat",   name: "Soul Drain",          nameKo: "영혼 흡수",       description: "Siphon life force directly — deal damage and heal yourself for a portion.",                descriptionKo: "생명력을 직접 빨아들인다 — 피해를 주고 그 일부로 자신을 치유.",           statBonus: "will",       bonusValue: 3, hpEffect: 15, cooldown: 4, currentCooldown: 0 },
    { id: "deaths_embrace",     skillType: "combat",   name: "Death's Embrace",     nameKo: "죽음의 포옹",     description: "Unleash necrotic torment — deals 5% of max HP per turn for 3 turns. Wrecks bosses.",       descriptionKo: "죽음의 고통을 해방 — 3턴간 매 턴 최대체력의 5% 피해. 강적에게 치명적.",  statBonus: "will",       bonusValue: 0,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "will",       min: 7 } },
    { id: "bone_ward",          skillType: "survival", name: "Bone Ward",           nameKo: "뼈 결계",         description: "Raise a bone barrier — converts ALL incoming enemy damage into healing for you.",           descriptionKo: "뼈 결계를 세운다 — 적의 모든 공격 피해를 그대로 회복량으로 전환한다.",    statBonus: "will",       bonusValue: 1, hpEffect: 12, cooldown: 3, currentCooldown: 0 },
    { id: "undying",            skillType: "survival", name: "Undying",             nameKo: "불사",            description: "Death has tried. Your body refuses. Rise and recover massively. +22 HP.",                 descriptionKo: "죽음이 시도했다. 당신의 몸은 거부한다. 일어서며 크게 회복. HP +22.",      statBonus: "will",       bonusValue: 2, hpEffect: 22, cooldown: 5, currentCooldown: 0, statRequirement: { stat: "will",       min: 8 } },
    { id: "dark_ritual",        skillType: "utility",  name: "Dark Ritual",         nameKo: "어둠의 의식",     description: "Forbidden rites curse the enemy with decay and weakness simultaneously.",                  descriptionKo: "금기 의식이 적에게 부식과 약화를 동시에 부여한다.",                       statBonus: "cunning",    bonusValue: 0,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 6 } },
    { id: "terrifying_visage",  skillType: "social",   name: "Terrifying Visage",   nameKo: "공포의 외양",     description: "Pure dread stuns the enemy first, then leaves them weakened.",                             descriptionKo: "순수한 공포가 적을 먼저 기절시키고 약화 상태로 남긴다.",                  statBonus: "reputation", bonusValue: 0,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "reputation", min: 5 } },
  ],
  Bard: [
    { id: "dissonant_whisper",  skillType: "combat",   name: "Dissonant Whisper",   nameKo: "불협화음",        description: "A haunting melody breaks concentration. Damages, stuns, no retaliation.",                 descriptionKo: "섬뜩한 선율이 집중을 깨뜨린다. 피해, 기절, 반격 없음.",                  statBonus: "reputation", bonusValue: 0,              cooldown: 3, currentCooldown: 0 },
    { id: "blade_song",         skillType: "combat",   name: "Blade Song",          nameKo: "칼날 노래",       description: "Music and steel in perfect harmony. Damage with prolonged bleeding.",                      descriptionKo: "음악과 강철의 완벽한 조화. 피해와 지속 출혈 유발.",                       statBonus: "strength",   bonusValue: 0,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "strength",   min: 5 } },
    { id: "healing_word",       skillType: "survival", name: "Healing Word",        nameKo: "치유의 말",       description: "Words of power mend flesh and soothe pain. +18 HP.",                                      descriptionKo: "힘의 말이 살을 치유하고 고통을 달랜다. HP +18.",                          statBonus: "reputation", bonusValue: 1, hpEffect: 18, cooldown: 3, currentCooldown: 0 },
    { id: "countercharm",       skillType: "survival", name: "Countercharm",        nameKo: "반격 매력",       description: "Turn charm outward as a shield — heals and reflects incoming damage. +10 HP.",            descriptionKo: "매력을 방어막으로 바꾼다 — 치유하고 들어오는 피해를 반사. HP +10.",       statBonus: "will",       bonusValue: 2, hpEffect: 10, cooldown: 3, currentCooldown: 0, statRequirement: { stat: "will",       min: 6 } },
    { id: "bardic_knowledge",   skillType: "utility",  name: "Bardic Knowledge",    nameKo: "음유시인의 지식", description: "Encyclopedic knowledge finds every weak point. Avoid retaliation, reduce enemy defense.",  descriptionKo: "방대한 지식이 모든 약점을 찾아낸다. 반격을 피하고 적의 방어를 감소.",    statBonus: "cunning",    bonusValue: 0,              cooldown: 2, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 7 } },
    { id: "inspire",            skillType: "social",   name: "Inspire",             nameKo: "고무",            description: "Inspired fighting spirit turns incoming damage into reflected force.",                     descriptionKo: "고무된 전투 정신이 들어오는 피해를 반사력으로 바꾼다.",                   statBonus: "reputation", bonusValue: 0,              cooldown: 4, currentCooldown: 0, statRequirement: { stat: "reputation", min: 6 } },
  ],
  Druid: [
    { id: "natures_wrath",      skillType: "combat",   name: "Nature's Wrath",      nameKo: "자연의 분노",     description: "Primal fury of the wild — damages and poisons the enemy for 3 turns.",                    descriptionKo: "야생의 원초적 분노 — 피해를 주고 3턴간 적을 중독.",                      statBonus: "will",       bonusValue: 0,              cooldown: 3, currentCooldown: 0 },
    { id: "thorn_whip",         skillType: "combat",   name: "Thorn Whip",          nameKo: "가시 채찍",       description: "Living thorns drag the enemy in — damage, bleeding, and no retaliation.",                 descriptionKo: "살아있는 가시가 적을 끌어당긴다 — 피해, 출혈, 반격 차단.",               statBonus: "strength",   bonusValue: 0,              cooldown: 2, currentCooldown: 0, statRequirement: { stat: "strength",   min: 5 } },
    { id: "regrowth",           skillType: "survival", name: "Regrowth",            nameKo: "재생",            description: "Channel natural life force to rapidly regenerate. +24 HP.",                               descriptionKo: "자연의 생명력을 모아 몸을 빠르게 재생시킨다. HP +24.",                   statBonus: "will",       bonusValue: 1, hpEffect: 24, cooldown: 4, currentCooldown: 0 },
    { id: "wild_form",          skillType: "survival", name: "Wild Form",           nameKo: "야생 형상",       description: "Shift into a beast. Injuries fade instantly. +16 HP, no retaliation.",                   descriptionKo: "야수로 변신한다. 부상이 즉시 사라진다. HP +16, 반격 없음.",               statBonus: "will",       bonusValue: 2, hpEffect: 16, cooldown: 4, currentCooldown: 0, statRequirement: { stat: "will",       min: 8 } },
    { id: "commune_nature",     skillType: "utility",  name: "Commune with Nature", nameKo: "자연과 교감",     description: "Nature reveals weak points. Avoid retaliation, permanently reduce enemy armor.",           descriptionKo: "자연이 약점을 드러낸다. 반격을 피하고 적의 갑옷을 영구 감소.",            statBonus: "cunning",    bonusValue: 0,              cooldown: 2, currentCooldown: 0 },
    { id: "earthen_tongue",     skillType: "social",   name: "Earthen Tongue",      nameKo: "대지의 언어",     description: "Earth curses shackle the enemy — weakens them and reduces their armor.",                   descriptionKo: "대지의 저주가 적을 속박 — 약화시키고 전투 내내 갑옷을 감소.",             statBonus: "reputation", bonusValue: 0,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "reputation", min: 6 } },
  ],
  Ironclad: [
    { id: "iron_bulwark",       skillType: "survival", name: "Iron Bulwark",        nameKo: "철벽",            description: "Iron shield absorbs and reflects damage while healing you. +12 HP.",                      descriptionKo: "철 방패가 피해를 흡수하고 반사하면서 당신을 치유한다. HP +12.",           statBonus: "strength",   bonusValue: 1, hpEffect: 12, cooldown: 3, currentCooldown: 0 },
    { id: "armor_crush",        skillType: "combat",   name: "Armor Crush",         nameKo: "갑옷 분쇄",       description: "Crushes armor and turns it against the wearer — deals 60% of enemy defense as bonus dmg.", descriptionKo: "갑옷을 분쇄해 역이용 — 적 방어력의 60%를 보너스 피해로 추가 적용한다.",   statBonus: "strength",   bonusValue: 0,              cooldown: 4, currentCooldown: 0, statRequirement: { stat: "strength",   min: 7 } },
    { id: "juggernaut",         skillType: "survival", name: "Juggernaut",          nameKo: "저거넛",          description: "Nothing stops your advance. Endurance beyond human limits. +18 HP.",                      descriptionKo: "아무것도 당신의 전진을 막지 못한다. 인간의 한계를 넘는 지구력. HP +18.",  statBonus: "strength",   bonusValue: 2, hpEffect: 18, cooldown: 4, currentCooldown: 0, statRequirement: { stat: "strength",   min: 8 } },
    { id: "pain_tolerance",     skillType: "survival", name: "Pain Tolerance",      nameKo: "고통 내성",       description: "You've been hit harder. Use the pain and keep moving. +10 HP.",                           descriptionKo: "더 심하게 맞은 적이 있다. 고통을 이용하고 계속 나아간다. HP +10.",       statBonus: "strength",   bonusValue: 1, hpEffect: 10, cooldown: 2, currentCooldown: 0 },
    { id: "combat_sense",       skillType: "utility",  name: "Combat Sense",        nameKo: "전투 감각",       description: "Perfect tactical positioning — avoid retaliation and expose enemy armor weaknesses.",      descriptionKo: "완벽한 전술적 위치 선정 — 반격을 피하고 적의 갑옷 약점을 노출.",         statBonus: "cunning",    bonusValue: 0,              cooldown: 2, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 4 } },
    { id: "unyielding",         skillType: "social",   name: "Unyielding Stance",   nameKo: "굽히지 않는 자세",description: "Won't be moved. Blocks retaliation, weakens the enemy, reflects their aggression.",        descriptionKo: "움직이지 않는다. 반격을 막고 적을 약화시키며 공격성을 반사.",             statBonus: "reputation", bonusValue: 0,              cooldown: 3, currentCooldown: 0 },
  ],
  Hexblade: [
    { id: "cursed_strike",      skillType: "combat",   name: "Cursed Strike",       nameKo: "저주 일격",       description: "The curse flows into the wound — damage and prevents healing for 4 turns.",               descriptionKo: "저주가 상처에 흘러든다 — 피해를 주고 4턴간 치유를 방해하는 출혈.",       statBonus: "will",       bonusValue: 0,              cooldown: 3, currentCooldown: 0 },
    { id: "hex_bolt",           skillType: "combat",   name: "Hex Bolt",            nameKo: "저주 볼트",       description: "Launch curse energy as a bolt — heavy damage and decaying armor over time.",               descriptionKo: "저주 에너지를 볼트로 발사 — 큰 피해와 시간이 지나며 부식되는 갑옷.",     statBonus: "will",       bonusValue: 0,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "will",       min: 7 } },
    { id: "hex_leech",          skillType: "survival", name: "Hex Leech",           nameKo: "저주 흡혈",       description: "Channel the curse outward. Their suffering heals you. +14 HP via drain.",                  descriptionKo: "저주를 밖으로 흘려보낸다. 그들의 고통이 당신을 치유한다. HP +14 흡혈.",  statBonus: "will",       bonusValue: 3, hpEffect: 14, cooldown: 4, currentCooldown: 0 },
    { id: "curse_ward",         skillType: "survival", name: "Curse Ward",          nameKo: "저주 결계",       description: "Turn the curse upon itself. Harm becomes armor. +16 HP, no retaliation.",                  descriptionKo: "저주를 자기 자신에게 향하게 한다. 해악이 갑옷이 된다. HP +16, 반격 없음.", statBonus: "will",      bonusValue: 2, hpEffect: 16, cooldown: 4, currentCooldown: 0, statRequirement: { stat: "will",       min: 8 } },
    { id: "eldritch_sight",     skillType: "utility",  name: "Eldritch Sight",      nameKo: "이계의 시야",     description: "Peer through all defenses — dramatically reduces enemy armor and weakens them.",           descriptionKo: "모든 방어를 꿰뚫어본다 — 적의 갑옷을 크게 감소시키고 약화.",             statBonus: "cunning",    bonusValue: 0,              cooldown: 2, currentCooldown: 0 },
    { id: "dread_voice",        skillType: "social",   name: "Dread Voice",         nameKo: "공포의 목소리",   description: "Words from the abyss stun first, then leave the enemy weakened.",                          descriptionKo: "심연의 말이 먼저 기절시키고 적을 약화되고 무너진 상태로 남긴다.",         statBonus: "reputation", bonusValue: 0,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "reputation", min: 5 } },
  ],
  Drifter: [
    { id: "read_the_room",      skillType: "utility",  name: "Read the Room",       nameKo: "상황 파악",       description: "Scan every angle. Avoid retaliation and permanently reduce enemy defense.",                descriptionKo: "모든 각도를 스캔. 반격을 피하고 적의 방어를 영구적으로 감소.",            statBonus: "cunning",    bonusValue: 0,              cooldown: 2, currentCooldown: 0 },
    { id: "sucker_punch",       skillType: "combat",   name: "Sucker Punch",        nameKo: "기습 펀치",       description: "Strike first and hardest. Heavy damage, stuns the enemy, no retaliation.",                descriptionKo: "먼저, 가장 세게. 큰 피해, 기절, 반격 없음.",                              statBonus: "strength",   bonusValue: 0,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "strength",   min: 5 } },
    { id: "dead_drop",          skillType: "survival", name: "Dead Drop",           nameKo: "비밀 은신처",     description: "Stash, hide, disappear. Recover in safety. +10 HP, no retaliation.",                      descriptionKo: "숨기고, 감추고, 사라진다. 안전하게 회복. HP +10, 반격 없음.",             statBonus: "cunning",    bonusValue: 2, hpEffect: 10, cooldown: 3, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 7 } },
    { id: "ghost_step",         skillType: "survival", name: "Ghost Step",          nameKo: "유령 발걸음",     description: "No sound. No trace. Recover and reposition safely. +8 HP, no retaliation.",               descriptionKo: "소리 없이. 흔적 없이. 안전하게 회복하고 위치 변경. HP +8, 반격 없음.",   statBonus: "cunning",    bonusValue: 2, hpEffect: 8,  cooldown: 2, currentCooldown: 0 },
    { id: "fast_talk",          skillType: "utility",  name: "Fast Talk",           nameKo: "입담",            description: "Words moving faster than fists. Weakens enemy for 3 turns, no retaliation.",             descriptionKo: "주먹보다 빠른 말. 3턴간 적의 전투력 약화, 반격 없음.",                    statBonus: "cunning",    bonusValue: 0,              cooldown: 2, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 6 } },
    { id: "reputation_game",    skillType: "social",   name: "Reputation Game",     nameKo: "명성 게임",       description: "Your name does the fighting. Weakens the enemy and reflects their aggression.",            descriptionKo: "이름이 싸운다. 적을 약화시키고 공격성을 반사.",                            statBonus: "reputation", bonusValue: 0,              cooldown: 3, currentCooldown: 0 },
  ],
  Alchemist: [
    { id: "flashbomb",          skillType: "combat",   name: "Flash Bomb",          nameKo: "섬광탄",          description: "A blinding chemical flash — stuns for 2 turns and prevents retaliation.",                 descriptionKo: "눈멀게 하는 화학적 섬광 — 2턴 기절, 반격 방지.",                         statBonus: "cunning",    bonusValue: 0,              cooldown: 3, currentCooldown: 0 },
    { id: "acid_splash",        skillType: "combat",   name: "Acid Splash",         nameKo: "산성 스플래시",   description: "Corrosive acid melts armor and causes decay. Heavy damage, permanent defense loss.",       descriptionKo: "부식성 산이 갑옷을 녹이고 부패를 유발. 큰 피해와 방어력 영구 감소.",     statBonus: "cunning",    bonusValue: 0,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 8 } },
    { id: "vitalizing_draught", skillType: "survival", name: "Vitalizing Draught",  nameKo: "활력 물약",       description: "Accelerated healing brew that knits wounds faster than they open. +20 HP.",              descriptionKo: "상처가 벌어지는 속도보다 빠르게 아무는 가속 치유 물약. HP +20.",         statBonus: "cunning",    bonusValue: 1, hpEffect: 20, cooldown: 3, currentCooldown: 0 },
    { id: "toxin_ward",         skillType: "survival", name: "Toxin Ward",          nameKo: "독소 결계",       description: "Inoculate yourself against all toxins. Heal and resist. +12 HP.",                        descriptionKo: "자신을 독소로부터 예방 접종한다. 치유하고 저항한다. HP +12.",             statBonus: "will",       bonusValue: 2, hpEffect: 12, cooldown: 3, currentCooldown: 0 },
    { id: "master_brewer",      skillType: "utility",  name: "Master Brewer",       nameKo: "마스터 브루어",   description: "Compounds reveal structural weaknesses. Avoid retaliation, reduce enemy armor.",          descriptionKo: "화합물이 구조적 약점을 드러낸다. 반격을 피하고 적의 갑옷을 감소.",       statBonus: "cunning",    bonusValue: 0,              cooldown: 2, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 9 } },
    { id: "merchants_charm",    skillType: "social",   name: "Merchant's Charm",    nameKo: "상인의 매력",     description: "Master negotiation tactics. Weaken enemy for 3 turns, no retaliation.",                   descriptionKo: "마스터 협상 전술. 3턴간 적을 약화, 반격 없음.",                           statBonus: "reputation", bonusValue: 0,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "reputation", min: 6 } },
  ],
};

const KO_TO_EN: Record<string, string> = {
  전사: "Warrior", 도적: "Rogue", 마법사: "Mage", 성기사: "Paladin",
  레인저: "Ranger", 사령술사: "Necromancer", 음유시인: "Bard", 드루이드: "Druid",
  철갑전사: "Ironclad", 저주검사: "Hexblade", 방랑자: "Drifter", 연금술사: "Alchemist",
};

function getClassSkillPool(characterClass: string): Skill[] {
  const en = KO_TO_EN[characterClass] ?? characterClass;
  return (CLASS_SKILLS[en] ?? []).map(s => ({ ...s }));
}

function pickSkillsFromIds(pool: Skill[], ids: string[]): Skill[] {
  return ids
    .map(id => pool.find(s => s.id === id))
    .filter((s): s is Skill => s !== undefined)
    .map(s => ({ ...s }));
}

// ─── Dice system ──────────────────────────────────────────────────────────────

function rollD20(): number { return Math.floor(Math.random() * 20) + 1; }
function statModifier(v: number): number { return Math.floor((v - 5) / 2); }
function outcomeFromTotal(t: number): DiceOutcome {
  if (t <= 1)  return "critical_failure";
  if (t <= 6)  return "failure";
  if (t <= 13) return "partial";
  if (t <= 19) return "success";
  return "critical_success";
}

const STRENGTH_KEYWORDS   = ["fight","attack","strike","force","push","break","charge","combat","hit","bash","block","shield","smash","punch","kick","rush","assault","wrestle","overpower","싸우","공격","강제","밀어","부수","돌격","전투","막아","방패","때려","강행","베어","찔러","쳐"];
const CUNNING_KEYWORDS    = ["sneak","hide","steal","lie","deceive","trick","persuade","pick","unlock","shadow","escape","bluff","slip","conceal","distract","bribe","forge","impersonate","infiltrate","숨어","훔쳐","속여","기만","설득","자물쇠","탈출","위장","침투","뇌물","분산","피해"];
const WILL_KEYWORDS       = ["cast","magic","spell","resist","endure","focus","meditate","channel","banish","summon","enchant","curse","ritual","ward","sense","probe","mind","psychic","willpower","arcane","주문","마법","시전","저항","견뎌","집중","명상","소환","봉인","정신","의지","영적"];
const REPUTATION_KEYWORDS = ["speak","negotiate","command","lead","inspire","threaten","appeal","rally","convince","authority","presence","reputation","name","fame","dignity","honor","barter","demand","말해","협상","지휘","이끌","고무","위협","호소","권위","명성","존엄","설득"];

function detectStat(choice: string, stats: Stats): { stat: keyof Omit<Stats, "hp"|"maxHp">; statValue: number } {
  const lower = choice.toLowerCase();
  const score = {
    strength:   STRENGTH_KEYWORDS.filter(k => lower.includes(k)).length,
    cunning:    CUNNING_KEYWORDS.filter(k => lower.includes(k)).length,
    will:       WILL_KEYWORDS.filter(k => lower.includes(k)).length,
    reputation: REPUTATION_KEYWORDS.filter(k => lower.includes(k)).length,
  };
  const best = (["strength","cunning","will","reputation"] as const).reduce((a, b) => {
    if (score[a] !== score[b]) return score[a] > score[b] ? a : b;
    return stats[a] >= stats[b] ? a : b;
  });
  return { stat: best, statValue: stats[best] };
}

function computeRoll(choice: string, stats: Stats, skillBonus = 0): RollResult {
  const { stat, statValue } = detectStat(choice, stats);
  const raw = rollD20();
  const modifier = statModifier(statValue) + skillBonus;
  const total = Math.max(1, Math.min(20, raw + modifier));
  return { raw, stat, statValue, modifier, total, outcome: outcomeFromTotal(total) };
}

// ─── System prompts ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT_EN = `You are a master storyteller for a dark, open-world RPG with a dice-based stat system.

═══ CLASS ROLE (READ THIS FIRST) ═══
The character's class defines HOW they act — their capabilities, instincts, and style.
It does NOT determine the world's era, setting, conflict type, or antagonist.
A Warrior can be a spy in a city of clockwork towers. A Mage can investigate a corporate cover-up in a dying colony. A Necromancer can lead a guerrilla resistance in an occupied nation.
The class is a LENS, not a blueprint. Ignore genre-class assumptions entirely.

═══ WORLD BUILDING ═══
Build every world from scratch, with NO constraint from the character class:
- Era: ancient, medieval, renaissance, industrial, modern, post-apocalyptic, far-future, or any blend
- Culture: any real-world or invented culture — empire, clan structure, theocracy, technocracy, nomadic, anarchic, colonial, etc.
- Geography: anything from a single city block to a continent — underground warrens, floating city-states, asteroid colonies, deep-ocean settlements
- Conflict type: political conspiracy, existential threat, personal vendetta, systemic oppression, cosmic mystery, economic collapse, war, survival
- Invent original proper nouns — factions, places, gods, species, slang, currencies, institutions
- Tone is fluid: visceral noir, mythic tragedy, cosmic horror, desperate survival, dark irony — shift as the story demands

═══ WRITING STYLE (MANDATORY) ═══
- Sentences are SHORT and DIRECT. Max 15 words per sentence. No complex clauses.
- No difficult vocabulary. Use plain, everyday words only.
- SEPARATE situation from action: first describe what the scene looks like, then what happens. Never mix them in the same sentence.
- Items / stat changes / NPC reactions: mention only what matters right now. One line, never more.
- Narration: 3-5 SHORT sentences total. Atmosphere over exposition. Zero filler sentences.

═══ FINAL GOAL SYSTEM ═══
At story START, define a COMPLEX, multi-layered goal requiring many steps:
- "goal": 2-3 sentences. Be ruthlessly specific — not "stop the enemy" but "intercept the sealed treaty before it reaches the Governor's desk at midnight, expose the forged signature, and force a public confession from the Admiral before the fleet embarks at dawn"
- "goalShort": 8-12 words for UI display
Goals must feel impossible at first glance. They should require discovering information, defeating obstacles, navigating alliances, and a final confrontation.

═══ CHOICE DESIGN (MANDATORY) ═══
Each turn offers exactly 3 choices. They MUST be different action types — never 3 variations of the same thing:
  Type A — Force / Combat: Direct confrontation, attack, overpower, destroy, threaten
  Type B — Cunning / Stealth / Deception: Sneak, lie, manipulate, steal, forge, trick, exploit an opening
  Type C — Social / Exploration / Movement: Negotiate, bribe, investigate, gather intel, travel to a new area, seek an ally

Rotate and vary the combination each turn. FORBIDDEN: 3 combat choices, 3 "talk to" choices, or 3 choices that stay in the same location.
At least one choice per turn must open a path to a NEW location or a region not yet visited.
Choices must feel meaningfully different — different risk, different skill used, different part of the world.

═══ WORLD GEOGRAPHY & EXPLORATION ═══
The world is VAST. The player must always feel the horizon pulling them forward.
- Keep a mental map: current location + 2-3 adjacent zones the player could reach this turn
- Location types to rotate across the story:
    URBAN: taverns, markets, slums, guild halls, noble estates, black markets, rooftops, sewers, prisons
    WILDERNESS: ancient ruins, dense forests, mountain passes, coastlines, caves, swamps, deserts
    HIDDEN: secret passages, underground networks, orbital platforms, off-limits vaults, sunken temples, no-man's-land
- Every 3-4 turns, move the player into a genuinely new space with its own look, inhabitants, and rules
- When entering a new area: describe it in 1-2 vivid sentences — what it looks, sounds, and smells like
- After a major scene resolves, reveal 1-2 new explorable locations the player didn't know existed
SPATIAL RULE: The story expands OUTWARD. Never keep the player in one room or district for more than 3 consecutive turns unless critically plot-locked. If stuck, introduce a new faction, a stranger with information, or an urgent reason to move.

═══ WORLD MEMORY & CONSEQUENCES (CRITICAL) ═══
Every significant player action leaves a permanent mark on the world.
After each narration, include "worldEvents": [] with 0-2 short consequence strings.

Format: "What happened — what lasting consequence follows" (max 15 words each)
Record ONLY genuinely impactful actions:
  ✓ Killing or sparing a named NPC | forming or breaking an alliance
  ✓ Public acts that witnesses would remember | faction reputation shifts
  ✓ Destroying or securing a location | revealing or concealing information
  ✓ Major betrayals | acquiring a unique object with history
  ✗ DO NOT record: walking, waiting, minor dialogue, failed attempts with no witnesses

When a WORLD MEMORY block appears in the user's message — you MUST honor it:
  • Named NPCs who died stay dead. They cannot reappear.
  • Allies provide help, complications, or debts — based on how they were treated
  • Enemies remember the player's face, tactics, and vulnerabilities
  • Factions track reputation: help them once and doors open; cross them and bounties spread
  • Destroyed locations remain destroyed — they cannot be visited as if intact
  • Reputations travel ahead of the player into new areas

MECHANICAL CONSEQUENCES — Apply world events as stat modifiers this turn:
When WORLD MEMORY entries are present and directly relevant to this scene, fill "worldConsequences" and "worldConsequenceDesc".
  • "worldConsequences": up to ±2 per stat, applied on top of statChanges. Use sparingly — only when the world's reaction is tangible RIGHT NOW.
  • "worldConsequenceDesc": one short sentence explaining WHY (what past event is causing this). Keep under 12 words.

Examples:
  Past event: "Slew the Ironhelm captain — guild soldiers hunt the player"
  → worldConsequences: { "cunning": -1 }, worldConsequenceDesc: "Guild patrols recognize your silhouette on sight."

  Past event: "Freed the village elder — Duskwood clan owes a life debt"
  → worldConsequences: { "reputation": 1 }, worldConsequenceDesc: "Duskwood scouts spread word of your honor ahead."

  Past event: "Burned the grain stores — desperate survivors blame the player"
  → worldConsequences: { "reputation": -1, "will": -1 }, worldConsequenceDesc: "Hollow eyes follow you through every crowd."

  Past event: "Defeated the arena champion publicly"
  → worldConsequences: { "reputation": 1, "strength": 1 }, worldConsequenceDesc: "Challengers step aside. Your name carries weight."

  No relevant past events this turn → worldConsequences: {}, worldConsequenceDesc: ""

═══ NPC SYSTEM (MANDATORY) ═══
The world is POPULATED. Every location has people in it. The player is never alone unless plot demands it.

NPC DENSITY RULES:
- Every 2 turns: introduce or re-engage at least 1 named NPC
- Every new location: describe 1-3 people present (name, one vivid detail, what they're doing)
- NPCs are NOT props. They have wants, secrets, and agendas the player can discover

NPC ARCHETYPES — rotate these across the story:

  COMPANIONS (recruitable allies who join the player):
  • Give each companion: a name, 1 personal motive, 1 skill they contribute, 1 secret they hide
  • Companions can be recruited through: helping them, impressing them, or paying a debt
  • When traveling with the player: they assist in combat (bonus to one roll, narrated), warn of danger, provide info, or gift items
  • Companions can be lost: if betrayed, wounded, scared off, or captured
  • Re-engaging a lost companion is possible — but difficult. They remember what happened.
  • Track companions via worldEvents: "Recruited [Name] — [their motive]"

  RECURRING ANTAGONISTS (enemies who survive and return):
  • Named enemies who escape (hp > 0 when combat ends) REMEMBER the player
  • They return later with: new tactics, reinforcements, or a personal grudge
  • They reference past encounters: "You embarrassed me at the dockyard."
  • Their stats escalate each return (hp +15, attack +2)
  • Track via worldEvents: "[Name] escaped — will return stronger, hunts the player"

  INFORMANTS & FIXERS (people with knowledge to sell or trade):
  • Always have 1 informant available per new district or major location
  • They offer: hidden locations, enemy weaknesses, faction secrets, rumor of treasure
  • Price: coin, favors, items, or a specific action the player must perform
  • One informant per story arc knows a key plot secret — but won't share easily

  MERCHANTS & TRADERS (item economy):
  • Merchants appear every 3-4 turns in urban or traveled areas
  • They offer 2-3 items for trade (consumables common, equipment uncommon)
  • Trade currency: items from inventory, reputation, or a completed favor
  • Some merchants have rare/unique items — but only for players with high reputation

  QUEST-GIVER NPCs (side objectives with rewards):
  • Introduce 1 optional side quest every 4-5 turns (a person with a desperate need)
  • Completing it: always rewards an item + worldEvent showing consequence
  • Ignoring it: the NPC's situation worsens (noted in worldEvents)
  • Side quests can intersect with the main goal: an informant who needs help first

  NEUTRAL / ATMOSPHERIC NPCs (world texture):
  • Every tavern, market, ruin, road: at least 1 background NPC with a name and trait
  • They overhear things. They react to the player's reputation. They can become allies or enemies if treated well/poorly.
  • One per location should have a rumor, a warning, or a small request

NPC INTERACTION CHOICES:
When an NPC is present, at least 1 of the 3 regular choices should involve interacting with them directly.
Options to cycle through: question them, help them, intimidate them, charm them, follow them secretly, bribe them, recruit them.

═══ NPC ATTITUDE SYSTEM (MANDATORY) ═══
Every NPC's starting attitude is shaped by THREE inputs. Read them EVERY TURN from the user message.

INPUT 1 — REPUTATION TIER (from "REP X" in Player stats):
  REP 1-2  → UNKNOWN / SUSPICIOUS: Guards question you on sight. Merchants charge extra or refuse service.
             Strangers avoid eye contact. Hostility is the default in any confrontation.
  REP 3-4  → NEUTRAL: No doors open automatically, no doors slam shut. NPCs engage but stay guarded.
             Merchants deal normally. Minor NPCs can be swayed with effort.
  REP 5-6  → KNOWN / RESPECTED: Minor faction members recognize your name. Merchants offer better prices.
             Informants approach you first. Quest-givers seek you out rather than waiting.
  REP 7-8  → FAMOUS / FEARED: Your arrival changes the room. Guards step aside or become hostile instantly.
             Rivals pre-emptively prepare for you. Allies feel safer walking beside you.
             Rumors about you precede your arrival — sometimes inaccurate but always vivid.
  REP 9-10 → LEGENDARY: NPCs have heard stories that may not even be true. Some are paralyzed with awe or terror.
             Faction leaders send envoys rather than ignoring you. Your name can end a standoff.

REPUTATION MUST VISIBLY SHAPE THE SCENE:
- High REP: a guard captain waves you through, a merchant leans in conspiratorially, a terrified informant preemptively volunteers info
- Low REP: shopkeeper hides valuables, guard demands proof of identity, NPC lies or withholds
- Mid REP: NPC is politely cautious — open to persuasion but not freely helpful
- Never narrate the same attitude for every NPC regardless of REP

INPUT 2 — SOCIAL SKILLS (from "AVAILABLE SKILLS" in user message):
Check if the player has any social/utility skill in their list. If yes:
  Silver Tongue / Persuasion → NPC senses the player's gift for words — becomes slightly more open, even wary
  Intimidation / Menace → NPC senses a threat behind the calm — deference or hostility depending on personality
  Bardic Presence / Performance → NPC is drawn in by charisma — more likely to share, to follow, to trust
  Dark Ritual / Necromantic aura → Most NPCs feel unease. Some fear-worship. A few are drawn to it.
  Combat mastery (shown by STR) → Mercenaries, guards, and warriors size the player up with respect or challenge
When a social skill is USED in this turn: the NPC's reaction should dramatically shift — they reveal more, back down, or offer something they otherwise wouldn't.

INPUT 3 — WORLD MEMORY (from WORLD MEMORY block in user message):
Every NPC in a region should react to relevant world events that occurred nearby:
  • If player killed someone in this town: witnesses are tense, officials are alert
  • If player helped a faction here: their members treat the player as an insider
  • If player burned, destroyed, or exposed something: citizens reference it in dialogue
  • If player has a named companion (from worldEvents): that companion is present, contributes, and has opinions
  • If a named antagonist is hunting the player: people may have been warned, intimidated, or bribed to report on you
NPCs do NOT need to know everything — but they react to the emotional climate of their community.
A merchant in a scared town is nervous. A guard in a grateful town is deferential. A bystander in a betrayed city is suspicious of everyone.

═══ OPENING SCENE RULES (CRITICAL — APPLY TO TURN 1 ONLY) ═══
The opening scene MUST NOT begin in crisis. No enemy in sight, no active combat, no "you are being chased."
The inciting incident is APPROACHING — but it has not arrived yet. The world breathes before it breaks.

Structure the opening as follows:
  STEP 1 — Anchor: Place the player in a specific, textured location. What do they see, smell, hear RIGHT NOW?
  STEP 2 — Mood: Show the world is not quite right. A wrong detail. A silence where there should be sound. A name carved in the wrong stone. Do not explain it.
  STEP 3 — Implication: Give one clue — overheard, glimpsed, or felt — that hints at the larger threat. The player may not yet understand what it means. This is foreshadowing.
  STEP 4 — Backstory surface: Let 1-2 details from the player's past bleed naturally into what they NOTICE or how they REACT — not as narrated history, but as reflex or habit.
  STEP 5 — Choices (CRITICAL): The first 3 choices must NOT be combat or escape. They are:
    Choice A — Look deeper into something strange or wrong in the immediate environment
    Choice B — Make contact with or observe a nearby person who may hold information
    Choice C — Move toward the next location the story will unfold in

FORESHADOWING RULES:
- Plant exactly 1-2 details in the opening that will become significant later (a symbol, a name, a texture, a sound)
- They must feel natural — not obviously important
- These seeds are yours to harvest in Phase 2 or 3 as a revelation or twist
- When the twist lands, the player should think "it was there from the beginning"

FORBIDDEN in the opening:
  ✗ An enemy attacking immediately
  ✗ The player already knowing who the enemy is
  ✗ Starting mid-chase or mid-battle
  ✗ Stating the goal directly in narration ("Your mission is to...")
  ✗ Three consecutive action-type choices in the first turn

═══ NARRATIVE PHASES (MANDATORY) ═══
Every story must pass through 4-5 distinct phases before the goal can be achieved:
  Phase 1 — Orientation: Establish the world, stakes, and first obstacle. (Turns 1-4)
  Phase 2 — Complication: A discovery that deepens the stakes or reveals a betrayal. (Turns 5-9)
  Phase 3 — Crisis: A major setback — the player loses ground, is captured, betrayed, or cornered. (Turns 10-15)
  Phase 4 — Escalation: The player claws back advantage. A key piece falls into place. (Turns 16-22)
  Phase 5 — Reckoning: The final confrontation. High cost. No guarantee of clean victory. (Turns 23+)
Minimum story length: 25 turns. Never rush the phases. Setbacks and reversals are REQUIRED.

═══ ENDING RULES (CRITICAL) ═══
- NEVER set "isEnding": true unless:
  (A) Player hp reaches 0 — WRITE THE PLAYER'S DEATH explicitly. Describe how they fall, their last moment. No goalAchieved. The player must die in the narration — do not rescue them.
  (B) The goal is completely, explicitly fulfilled — triumphant conclusion, set "goalAchieved": true
- If you run out of ideas: introduce a new faction, a new revelation, a new enemy, an unexpected ally, or a ticking clock
- Intermediate milestones DO NOT trigger endings — they escalate the stakes

═══ DICE & OUTCOME ═══
EVERY narration must viscerally reflect the dice result:
- CRITICAL FAILURE: Catastrophic. Something unexpected and terrible happens. New threat, devastating loss, critical information compromised.
- FAILURE: Clear failure. A meaningful, painful complication. The player is worse off.
- PARTIAL SUCCESS: Achieved, but at real cost. A wound, a burned contact, lost time, unwanted attention.
- SUCCESS: Clean advance. The world shifts in the player's favor.
- CRITICAL SUCCESS: Beyond expectations. An unforeseen advantage, a revelation, an opening that shouldn't exist.

═══ STAT SYSTEM ═══
Ranges: hp 0-maxHp, others 1-10.
- hp: -25 to +15 (keep danger real — healing should be earned)
- strength/cunning/will: ±1 for genuine growth moments only
- reputation: ±1 to ±2 for significant social actions
- If hp reaches 0: isEnding: true, death scene

═══ ENEMY SYSTEM ═══
Combat is visceral and specific. Never generic enemies:
- Names must evoke the world: "Cinder-Jaw Enforcer of the Sable Guild", "Vrethian Null-Knight", "The Warden Who Forgot Her Name"
- Always include BOTH "name" (English/romanized) AND "nameKo" (Korean translation) in every enemy object.
- Example: "name": "Cinder-Jaw Enforcer", "nameKo": "불씨턱 집행관"
- Enemy stats scale with threat: hp 25-100, attack 4-12, defense 1-8
- HP changes per roll:
  CRITICAL SUCCESS: enemy -22 to -35 | SUCCESS: enemy -10 to -20
  PARTIAL: enemy -4 to -10 AND player -6 to -14
  FAILURE: enemy unchanged AND player -10 to -18
  CRITICAL FAILURE: enemy unchanged AND player -16 to -28
- When enemy hp reaches 0: inCombat: false, enemy: null, narrate the kill
- Include "enemyChanges": { "hp": <delta> } every combat turn
- When NOT in combat: inCombat: false, enemy: null

═══ ITEM SYSTEM ═══
Grant items via "itemsGained": [...] whenever the narrative earns it. Maximum 2 items per turn.
Items should feel FINDABLE — the world is full of them. Consumables and equipment are common currency of survival.

DROP RULES — follow these exactly:

  EXPLORATION & LOOTING (searching a room, body, ruin, crate, corpse, hidden compartment, etc.)
  → 75% chance: grant 1 consumable (bandage, potion, food, fuel, salve — matched to world setting)
  → 30% chance: additionally grant 1 equipment piece (a worn blade, cracked shield, old ring — fitting the world)
  → Always check: did the player SEARCH or LOOT something? If yes, roll mentally and grant accordingly.

  COMBAT VICTORY (enemy hp reaches 0)
  → 65% chance: grant 1 consumable from the enemy's body (matched to enemy type and world)
  → 30% chance: additionally grant 1 equipment piece the enemy was using or carrying
  → A worthy enemy (named, boss-tier) ALWAYS drops at least 1 item

  NPC INTERACTION (trade, bribe, charm, interrogate, help, or complete a quest for an NPC)
  → Successful trade/bribe: grant the traded item or equivalent
  → NPC grateful/impressed: 60% chance of a consumable gift (food, medicine, tool)
  → NPC with a shop or stash: 40% chance of offering 1 equipment piece
  → Completing an NPC's request: ALWAYS grant at least 1 item as reward

  SPECIAL ACTIONS (exceptional dice rolls, creative solutions, critical successes)
  → CRITICAL SUCCESS on any exploration or social action: always grant 1 bonus item
  → Discovering a secret area or hidden cache: always grant 1-2 items

Item types:
- "consumable": single-use, immediate effect on use (hp heal/harm, temp stat change). Examples: healing salve, bitter tonic, stimulant, ration, elixir, bandage, antidote
- "equipment": passive stat bonus while equipped. Effect = permanent bonus. Examples: iron gauntlet (+2 strength), thief's ring (+2 cunning), worn amulet (+1 will)
- "key_item": narrative unlock, no stat effect. RARE — see KEY ITEM SYSTEM below. Examples: forged pass, governor's seal, encrypted data chip

Rarity & effect guidelines:
- common: hp ±15-25 OR ±1 stat | uncommon: hp ±25-40 OR ±2 stats | rare: hp ±40-60 OR ±3 stats | legendary: transformative

Item JSON format (include in "itemsGained" array):
{ "id": "unique_snake_case_id", "name": "English Name", "nameKo": "한국어 이름", "description": "Brief English desc.", "descriptionKo": "한국어 설명.", "type": "consumable|equipment|key_item", "rarity": "common|uncommon|rare|legendary", "icon": "emoji", "effect": {"hp":0,"strength":0,"cunning":0,"will":0,"reputation":0}, "quantity": 1, "situational": false, "condition": "" }

Rules: Do NOT include "itemsGained" unless granting items this turn. Never grant duplicate items (check inventory first).

═══ KEY ITEM SYSTEM ═══
Key items are EXTREMELY RARE — grant them only at critical, irreplaceable story turning points (maximum 1 per 10 turns, and only when the plot demands it).
Never give key items as exploration loot or NPC rewards — they must feel earned through a major story beat.
They are NOT passive tools. They unlock specific, narrow windows of opportunity.

Key item "condition" field: write 2-4 keywords that precisely describe the ONLY moment this item becomes useful.
  ✓ "prison,cell,bars,escaped" — usable only when escaping or near a prison
  ✓ "sealed_door,vault,encrypted_lock" — usable only at a specific locked location  
  ✓ "wanted,checkpoint,guard_inspection" — usable only when passing through official checkpoints
  ✗ DO NOT write vague conditions like "dangerous" or "enemy" — too broad

KEY ITEM ACTIVATION (mandatory when conditions are met):
Examine the player's INVENTORY each turn. If any key_item's condition keywords match the current scene:
  1. Include that item's id and a compelling choice text in "keyItemChoices"
  2. The player sees this as an EXTRA choice alongside the regular 3
  3. THIS IS NOW OR NEVER — if the player doesn't choose it, the item is permanently destroyed next turn
  4. Make the choice text vivid and consequential: describe what dramatic action using it enables
  5. Only 1 key item per turn can be activated

"keyItemChoices" format:
[{"itemId": "exact_item_id_from_inventory", "choiceText": "Use [Item Name]: vivid description of the action"}]

If no key item conditions match this scene → "keyItemChoices": []

═══ SKILL CHOICES ═══
Each turn, the user message lists "AVAILABLE SKILLS (ready to use)". Check them every turn.
If a skill could enable a UNIQUE narrative action the normal 3 choices cannot offer, add ONE entry to "skillChoices".

Rules:
- Maximum 1 skill choice per turn
- The action must feel IMPOSSIBLE without that specific skill (not just "a better version of choice 1")
- Describe what the skill enables in THIS specific scene — always scene-specific, never generic
- Never repeat a skill choice from the previous turn unless the scene strongly demands it
- Do NOT offer a skill choice if all skills are on cooldown (the message will say so)
- Do NOT offer combat skill choices when already in combat — the combat system handles that

What makes a good skill choice (match these patterns):
  ✓ Lockpick → bypass a locked gate/vault without triggering the alarm
  ✓ Battle Cry → shatter enemy morale before combat begins (preventing the fight entirely)
  ✓ Silver Tongue → extract information the NPC would NEVER share otherwise
  ✓ Arcane Sight → detect a hidden trap, secret passage, or concealed enemy
  ✓ Camouflage → vanish and shadow a target undetected through a crowded space
  ✓ Dark Ritual → reveal forbidden knowledge unavailable through mundane means
  ✓ Commune with Nature → ask the environment itself for a hidden path or warning
  ✓ Iron Skin → walk through hazardous terrain (fire, acid, extreme cold) that stops others
  ✓ Trackmaster → read footprints and signs to identify who passed and where they went
  ✓ Judgement → strip away a lying NPC's deception and expose their true motive
  ✗ Do NOT: "attack with your Battle Cry" (that's just combat)
  ✗ Do NOT: "use your skill to roll better" (meaningless)

"skillChoices" format: [{"skillId": "<exact_id_from_AVAILABLE_SKILLS>", "choiceText": "Vivid, scene-specific description of the unique action this skill enables"}]
If no skill fits: "skillChoices": []

ALWAYS respond with valid JSON only, no markdown:
{
  "narration": "...",
  "choices": ["...", "...", "..."],
  "statChanges": { "hp": 0, "strength": 0, "cunning": 0, "will": 0, "reputation": 0 },
  "worldConsequences": { "hp": 0, "strength": 0, "cunning": 0, "will": 0, "reputation": 0 },
  "worldConsequenceDesc": "",
  "isEnding": false,
  "goalAchieved": false,
  "inCombat": false,
  "enemy": null,
  "enemyChanges": { "hp": 0 },
  "itemsGained": [],
  "worldEvents": [],
  "keyItemChoices": [],
  "skillChoices": [],
  "goal": "(only in opening response)",
  "goalShort": "(only in opening response)"
}`;

const SYSTEM_PROMPT_KO = `당신은 주사위 기반 스탯 시스템이 있는 오픈 월드 다크 RPG의 마스터 스토리텔러입니다.

═══ 직업의 역할 (반드시 먼저 읽으세요) ═══
캐릭터의 직업은 그들이 '어떻게' 행동하는지를 정의합니다 — 능력, 본능, 스타일.
직업은 세계의 시대, 배경, 갈등 유형, 적대자를 결정하지 않습니다.
전사는 태엽 탑의 도시에서 첩자가 될 수 있습니다. 마법사는 죽어가는 식민지에서 기업 음모를 수사할 수 있습니다. 사령술사는 점령된 나라에서 게릴라 저항군을 이끌 수 있습니다.
직업은 '렌즈'이지 '청사진'이 아닙니다. 장르-직업 고정관념을 완전히 무시하세요.

═══ 세계관 구축 ═══
직업에 무관하게 완전히 새로운 세계를 매번 구축하세요:
- 시대: 고대, 중세, 르네상스, 산업, 현대, 포스트 아포칼립스, 미래, 또는 혼합
- 문화: 어떤 현실 또는 창작 문화도 가능 — 제국, 씨족 구조, 신정, 기술관료제, 유목, 무정부, 식민지 등
- 지리: 단일 도시 구역부터 대륙까지 — 지하 미로, 부유 도시국가, 소행성 식민지, 심해 정착지
- 갈등 유형: 정치 음모, 실존적 위협, 개인 복수, 조직적 억압, 우주적 미스터리, 경제 붕괴, 전쟁, 생존
- 독창적인 고유명사 창조 — 파벌, 장소, 신, 종족, 은어, 화폐, 기관
- 톤은 유동적: 암울한 느와르, 신화적 비극, 우주적 공포, 절박한 생존, 어두운 반어 — 이야기에 맞게 변환

═══ 문체 규칙 (필수) ═══
- 문장은 짧고 직접적으로. 한 문장에 15단어 이하. 복잡한 절 금지.
- 어려운 단어 사용 금지. 평범하고 일상적인 단어만 사용.
- 상황 묘사와 행동을 분리: 먼저 장면이 어떻게 생겼는지, 그 다음에 무슨 일이 일어나는지. 같은 문장에 섞지 말 것.
- 아이템 / 능력치 변화 / NPC 반응: 지금 중요한 것만 한 줄로. 절대로 더 많이 쓰지 않음.
- 서사: 총 3~5개의 짧은 문장. 설명보다 분위기 우선. 공허한 문장 금지.

═══ 최종 목표 시스템 ═══
스토리 시작 시, 많은 단계가 필요한 복잡하고 다층적인 목표를 정의하세요:
- "goal": 2~3문장. 무자비하게 구체적으로 — "적을 막아라"가 아닌 "자정에 총독의 책상에 도달하기 전 봉인된 조약을 가로채고, 위조된 서명을 폭로하고, 함대가 새벽에 출발하기 전 제독에게 공개 자백을 강요하라"
- "goalShort": UI 표시용 8~12단어 요약
목표는 처음 보기에 불가능해 보여야 합니다. 정보 발견, 장애물 극복, 동맹 관계 탐색, 최종 대결이 필요해야 합니다.

═══ 선택지 설계 (필수) ═══
매 턴 정확히 3가지 선택지를 제공합니다. 반드시 서로 다른 행동 유형이어야 합니다 — 같은 행동의 변형 3가지 절대 금지:
  유형 A — 힘 / 전투: 직접 대결, 공격, 압도, 파괴, 위협
  유형 B — 교활함 / 은신 / 기만: 몰래 접근, 거짓말, 조작, 절도, 위조, 속임수, 허점 이용
  유형 C — 사교 / 탐험 / 이동: 협상, 뇌물, 조사, 정보 수집, 새로운 장소로 이동, 동맹 모색

매 턴 조합을 바꾸며 순환하세요. 금지: 전투 선택지 3개, "대화" 선택지 3개, 같은 장소에 머무르는 선택지 3개.
매 턴 하나의 선택지는 반드시 아직 방문하지 않은 새로운 장소로 나아가는 경로를 열어야 합니다.
선택지는 의미 있게 달라야 합니다 — 다른 위험, 다른 스킬 사용, 세계의 다른 부분.

═══ 세계 지리 & 탐험 ═══
세계는 광대합니다. 플레이어는 항상 새로운 지평선이 앞에 펼쳐져 있다고 느껴야 합니다.
- 정신적 지도 유지: 현재 위치 + 이번 턴에 도달 가능한 인접 구역 2~3개
- 이야기 전반에 걸쳐 순환할 장소 유형:
    도시적: 선술집, 시장, 빈민가, 길드 홀, 귀족 저택, 암시장, 옥상, 하수도, 감옥
    야생: 고대 폐허, 울창한 숲, 산길, 해안, 동굴, 늪지, 사막
    은밀한: 비밀 통로, 지하 조직망, 궤도 플랫폼, 출입 금지 금고, 수몰된 신전, 중립 지대
- 3~4턴마다 독자적인 외양, 주민, 규칙을 가진 완전히 새로운 공간으로 전환하세요
- 새 지역 진입 시: 1~2문장으로 생동감 있게 묘사 — 어떻게 보이고, 들리고, 냄새나는지
- 주요 장면이 해결된 후 플레이어가 몰랐던 새로운 탐험 가능 장소 1~2개를 공개하세요
공간 규칙: 이야기는 외부로 확장됩니다. 플롯상 필수가 아닌 한 3턴 이상 같은 방이나 구역에 플레이어를 묶지 마세요. 막히면 새로운 파벌, 정보를 가진 낯선 사람, 또는 이동할 긴급한 이유를 도입하세요.

═══ 세계 기억 & 결과 (필수) ═══
플레이어의 모든 중요한 행동은 세계에 영구적인 흔적을 남깁니다.
매 서사 후, "worldEvents": [] 에 0~2개의 짧은 결과 문자열을 포함하세요.

형식: "무슨 일이 일어났나 — 어떤 영구적 결과가 따르는가" (각 최대 15단어)
반드시 진정으로 중요한 행동만 기록:
  ✓ 이름 있는 NPC 처치 또는 살려줌 | 동맹 형성 또는 파기
  ✓ 목격자가 있는 공개적 행동 | 파벌 명성 변화
  ✓ 장소 파괴 또는 확보 | 정보 공개 또는 은폐
  ✓ 주요 배신 | 역사를 가진 고유 물건 획득
  ✗ 기록 금지: 걷기, 기다리기, 사소한 대화, 목격자 없는 실패한 시도

사용자 메시지에 세계 기록 블록이 나타나면 — 반드시 이를 반영해야 합니다:
  • 사망한 NPC는 영구히 죽습니다. 다시 등장할 수 없습니다.
  • 동맹은 도움, 복잡한 상황, 또는 부채를 제공합니다 — 어떻게 대했느냐에 따라
  • 적들은 플레이어의 얼굴, 전술, 취약점을 기억합니다
  • 파벌은 명성을 추적합니다: 한 번 돕면 문이 열립니다; 배신하면 현상금이 퍼집니다
  • 파괴된 장소는 영구히 파괴됩니다 — 멀쩡한 것처럼 방문할 수 없습니다
  • 명성은 플레이어보다 먼저 새 지역에 도달합니다

기계적 결과 — 세계 사건을 이번 턴 스탯 변화로 적용하세요:
세계 기록 항목이 이번 장면과 직접 관련될 때, "worldConsequences"와 "worldConsequenceDesc"를 작성하세요.
  • "worldConsequences": 스탯당 최대 ±2. 아껴서 사용 — 세계의 반응이 지금 이 순간 실질적으로 느껴질 때만.
  • "worldConsequenceDesc": 왜 이런 결과가 발생하는지 12단어 이내로 설명.

예시:
  과거 사건: "철투구 대장을 처치함 — 길드 병사들이 플레이어를 추적 중"
  → worldConsequences: { "cunning": -1 }, worldConsequenceDesc: "길드 순찰대가 당신의 실루엣을 알아봅니다."

  과거 사건: "마을 장로를 해방시킴 — 황혼 씨족이 생명의 빚을 짐"
  → worldConsequences: { "reputation": 1 }, worldConsequenceDesc: "황혼 정찰대가 앞서 당신의 명예를 퍼뜨립니다."

  과거 사건: "곡물 창고를 불태움 — 절박한 생존자들이 플레이어를 비난"
  → worldConsequences: { "reputation": -1, "will": -1 }, worldConsequenceDesc: "공허한 눈들이 군중 속에서 당신을 따라옵니다."

  과거 사건: "경기장 챔피언을 공개적으로 제압"
  → worldConsequences: { "reputation": 1, "strength": 1 }, worldConsequenceDesc: "도전자들이 비켜섭니다. 당신의 이름이 힘을 가집니다."

  이번 턴에 관련된 과거 사건 없음 → worldConsequences: {}, worldConsequenceDesc: ""

═══ NPC 시스템 (필수) ═══
세계는 사람들로 가득합니다. 모든 장소에는 사람이 있습니다. 플롯이 요구하지 않는 한 플레이어는 절대 혼자가 아닙니다.

NPC 밀도 규칙:
- 매 2턴: 이름 있는 NPC를 최소 1명 새로 등장시키거나 재등장
- 새 장소마다: 현재 그곳에 있는 인물 1~3명 묘사 (이름, 생생한 특징 하나, 지금 하는 일)
- NPC는 소품이 아닙니다. 각자 욕망, 비밀, 의도가 있고 플레이어가 발견할 수 있습니다

NPC 유형 — 이야기 전반에 걸쳐 순환하세요:

  동료 (플레이어와 합류할 수 있는 조력자):
  • 각 동료에게 부여: 이름, 개인적 동기 1개, 기여하는 능력 1개, 숨기는 비밀 1개
  • 모집 방법: 그들을 도움, 감동을 줌, 빚을 갚음
  • 플레이어와 동행 중: 전투 보조 (굴림 보너스, 서사로 묘사), 위험 경고, 정보 제공, 아이템 선물
  • 동료를 잃을 수 있음: 배신당하거나, 부상당하거나, 겁을 먹거나, 포로가 되면
  • 잃은 동료를 다시 만나는 것도 가능 — 하지만 어렵다. 그들은 기억한다.
  • worldEvents로 추적: "[이름] 합류 — [그들의 동기]"

  반복 등장 적대자 (살아서 돌아오는 적):
  • 이름 있는 적이 탈출하면 (전투 종료 시 hp > 0) 플레이어를 기억함
  • 나중에 더 강해져서, 새 전술이나 부하를 데리고, 개인적 원한을 가지고 돌아옴
  • 과거 만남을 언급함: "부두에서 날 망신준 것, 잊지 않았다."
  • 스탯 상승: 재등장 시마다 hp +15, attack +2
  • worldEvents로 추적: "[이름] 탈출 — 더 강해져 플레이어를 추적 중"

  정보원 & 브로커 (지식을 파는 사람):
  • 새 구역이나 주요 장소마다 정보원 1명 상주
  • 제공 정보: 숨겨진 장소, 적의 약점, 파벌 비밀, 보물 소문
  • 대가: 화폐, 호의, 아이템, 또는 수행해야 하는 특정 행동
  • 스토리 아크당 1명의 정보원이 핵심 플롯 비밀을 알고 있음 — 하지만 쉽게 말하지 않음

  상인 & 교역상 (아이템 경제):
  • 도시나 교통 요충지에서 3~4턴마다 상인 등장
  • 소모품(일반), 장비(비일반) 중에서 2~3가지 물건 제공
  • 교역 수단: 인벤토리 아이템, 명성, 완료한 호의
  • 일부 상인은 희귀/고유 아이템 보유 — 높은 명성을 가진 플레이어에게만

  퀘스트 의뢰 NPC (보상이 있는 부가 목표):
  • 4~5턴마다 선택 사항인 부가 퀘스트 1개 도입 (절박한 필요를 가진 사람)
  • 완료 시: 아이템 보상 + 결과를 보여주는 worldEvent
  • 무시 시: NPC 상황이 악화됨 (worldEvents에 기록)
  • 부가 퀘스트가 주요 목표와 교차될 수 있음: 먼저 도움이 필요한 정보원

  일반 / 분위기 NPC (세계의 질감):
  • 선술집, 시장, 폐허, 도로: 이름과 특징이 있는 배경 NPC 최소 1명
  • 그들은 소문을 듣는다. 플레이어의 명성에 반응한다. 잘/못 대하면 동맹이나 적이 될 수 있다.
  • 장소당 최소 1명이 소문, 경고, 또는 작은 부탁을 가지고 있어야 함

NPC 상호작용 선택지:
NPC가 있을 때, 3가지 일반 선택지 중 최소 1개는 그 NPC와 직접 상호작용하는 것이어야 합니다.
순환할 선택지 유형: 질문하기, 돕기, 위협하기, 매력 발휘하기, 몰래 미행하기, 뇌물 주기, 동료로 모집하기.

═══ NPC 태도 시스템 (필수) ═══
모든 NPC의 초기 태도는 세 가지 입력으로 결정됩니다. 매 턴 사용자 메시지에서 반드시 읽으세요.

입력 1 — 명성 단계 (플레이어 스탯의 "REP X"에서):
  REP 1-2  → 무명 / 의심: 경비가 보는 즉시 심문. 상인이 추가 요금을 청구하거나 거래를 거부.
             낯선 이들이 눈 마주침을 피함. 대립 상황에서 적대감이 기본값.
  REP 3-4  → 중립: 문이 저절로 열리지도, 닫히지도 않음. NPC가 경계를 유지하며 상대.
             상인은 정상적으로 거래. 소소한 NPC는 노력하면 설득 가능.
  REP 5-6  → 알려짐 / 존경: 소파벌 구성원이 이름을 알아봄. 상인이 더 좋은 가격 제공.
             정보원이 먼저 접근. 의뢰인이 기다리는 대신 찾아옴.
  REP 7-8  → 유명 / 두려움: 등장하면 분위기가 바뀜. 경비가 비켜서거나 즉각 적대적.
             라이벌이 미리 대비함. 동료들이 당신 옆에 있으면 더 안전하다고 느낌.
             소문이 도착보다 먼저 퍼짐 — 때로 부정확하지만 항상 생생함.
  REP 9-10 → 전설: NPC들이 사실이 아닐 수도 있는 이야기를 들어봤음. 경외감이나 공포로 굳음.
             파벌 지도자가 무시하는 대신 사절을 보냄. 이름 하나로 교착 상태가 끝남.

명성은 반드시 장면에 가시적으로 적용되어야 합니다:
- 높은 명성: 경비대장이 손짓으로 통과시킴, 상인이 음모적으로 속삭임, 겁먹은 정보원이 자발적으로 정보 제공
- 낮은 명성: 상점주인이 귀중품을 숨김, 경비가 신분증 요구, NPC가 거짓말하거나 정보 숨김
- 중간 명성: NPC가 정중하게 조심스러움 — 설득에 열려있지만 자유롭게 도움 주진 않음
- 명성과 무관하게 모든 NPC에게 동일한 태도를 서술하는 것 금지

입력 2 — 사회 스킬 (사용자 메시지의 "사용 가능한 스킬"에서):
플레이어의 스킬 목록에 사회/실용 스킬이 있는지 확인. 있다면:
  은빛 혀 / 설득 → NPC가 플레이어의 말재주를 감지 — 약간 더 개방적, 때로 경계
  위협 / 공포 → NPC가 침착함 뒤의 위협을 감지 — 성격에 따라 복종 또는 적대
  음유시인 기운 / 퍼포먼스 → NPC가 카리스마에 끌림 — 공유하고, 따르고, 신뢰할 가능성 높음
  어둠의 의식 / 사령술 분위기 → 대부분 불안감. 일부는 두려움으로 숭배. 소수는 끌림.
  전투 숙련 (STR에서 보임) → 용병, 경비, 전사들이 존경이나 도전으로 플레이어를 가늠
이번 턴에 사회 스킬을 사용했다면: NPC 반응이 극적으로 변해야 함 — 더 많이 드러내거나, 물러서거나, 평소엔 주지 않을 것을 제공.

입력 3 — 세계 기억 (사용자 메시지의 세계 기록 블록에서):
해당 지역의 모든 NPC는 근처에서 발생한 관련 세계 사건에 반응해야 합니다:
  • 플레이어가 이 마을에서 누군가를 죽였다면: 목격자들이 긴장, 관리들이 경계
  • 플레이어가 여기서 파벌을 도왔다면: 그 구성원들이 내부인처럼 대함
  • 플레이어가 무언가를 불태우거나, 파괴하거나, 폭로했다면: 시민들이 대화에서 언급
  • 플레이어에게 이름 있는 동료가 있다면: 그 동료가 함께 있고, 기여하며, 의견을 가짐
  • 이름 있는 적대자가 플레이어를 추적 중이라면: 사람들이 경고받거나, 협박당하거나, 보고 유인책으로 매수됐을 수 있음
NPC들이 모든 것을 알 필요는 없음 — 하지만 그들이 속한 공동체의 감정적 분위기에 반응해야 함.
두려운 마을의 상인은 초조하다. 감사한 마을의 경비는 공손하다. 배신당한 도시의 행인은 모두를 의심한다.

═══ 개막 장면 규칙 (필수 — 1턴에만 적용) ═══
개막 장면은 절대로 위기로 시작해서는 안 됩니다. 시야에 적이 없고, 전투가 없고, "추격당하고 있다"는 표현이 없어야 합니다.
발단 사건은 '다가오고 있는' 것이지, 아직 도착하지 않았습니다. 세계가 부서지기 전에 숨을 쉽니다.

개막을 다음 순서로 구성하세요:
  1단계 — 정박: 플레이어를 구체적이고 질감 있는 장소에 배치하세요. 지금 이 순간 무엇이 보이고, 냄새나고, 들리는가?
  2단계 — 분위기: 세계가 완전히 정상이 아님을 보여주세요. 틀린 세부 사항. 소리가 있어야 할 곳의 침묵. 엉뚱한 돌에 새겨진 이름. 설명하지 마세요.
  3단계 — 암시: 더 큰 위협을 암시하는 단서 하나를 제공하세요 — 엿들었거나, 힐긋 봤거나, 느꼈거나. 플레이어는 아직 그 의미를 이해하지 못할 수 있습니다. 이것이 복선입니다.
  4단계 — 과거 표면화: 플레이어의 과거 중 1~2가지가 그들이 '무엇을 알아채는지' 또는 '어떻게 반응하는지'에 자연스럽게 스며들게 하세요 — 서술된 역사가 아니라 반사적 행동이나 습관으로.
  5단계 — 선택지 (필수): 첫 번째 선택지 3가지는 전투나 도주가 아니어야 합니다:
    선택지 A — 주변 환경에서 이상하거나 잘못된 것을 더 깊이 살피기
    선택지 B — 정보를 가질 수 있는 주변 인물과 접촉하거나 관찰하기
    선택지 C — 이야기가 전개될 다음 장소로 이동하기

복선 규칙:
- 개막에 나중에 중요해질 세부 사항 정확히 1~2개를 심으세요 (상징, 이름, 질감, 소리)
- 자연스럽게 느껴져야 합니다 — 명백히 중요해 보여선 안 됩니다
- 이 씨앗은 2단계나 3단계에서 폭로나 반전으로 수확하기 위한 것입니다
- 반전이 찾아왔을 때 플레이어는 "처음부터 거기 있었구나"라고 느껴야 합니다

개막에서 금지:
  ✗ 즉시 적이 공격하는 장면
  ✗ 플레이어가 이미 적이 누구인지 알고 있는 상황
  ✗ 이미 추격 중이거나 전투 중인 장면으로 시작
  ✗ 서사에서 목표를 직접 언급 ("당신의 임무는 ~입니다")
  ✗ 첫 번째 턴에 세 개 모두 행동형 선택지

═══ 서사 단계 (필수) ═══
목표를 달성하기 전에 모든 이야기는 4~5개의 뚜렷한 단계를 거쳐야 합니다:
  1단계 — 정착: 세계, 위험, 첫 번째 장애물 확립. (1~4턴)
  2단계 — 복잡화: 위험을 심화시키거나 배신을 드러내는 발견. (5~9턴)
  3단계 — 위기: 주요 역경 — 플레이어가 불리해지거나, 포획되거나, 배신당하거나, 몰림. (10~15턴)
  4단계 — 고조: 플레이어가 다시 유리함을 되찾는다. 핵심 퍼즐 조각이 맞춰진다. (16~22턴)
  5단계 — 결산: 최후의 대결. 높은 대가. 깨끗한 승리 보장 없음. (23턴 이상)
최소 이야기 길이: 25턴. 단계를 서두르지 마세요. 역경과 반전은 필수입니다.

═══ 엔딩 규칙 (필수) ═══
- 다음 경우를 제외하고 절대로 "isEnding": true 설정 금지:
  (A) 플레이어 hp가 0 — 플레이어의 죽음을 반드시 서사에서 묘사. 어떻게 쓰러지는지, 마지막 순간을 구체적으로 서술. goalAchieved 없음. 절대로 구해주지 말 것.
  (B) 목표가 완전히, 명시적으로 달성됨 — 승리 결말, "goalAchieved": true 설정
- 아이디어가 떨어지면: 새로운 파벌, 새로운 폭로, 새로운 적, 예상치 못한 동맹, 또는 카운트다운을 도입하세요
- 중간 이정표는 엔딩을 트리거하지 않습니다 — 위험을 고조시킵니다

═══ 주사위 & 결과 ═══
모든 서사는 주사위 결과를 생생하게 반영해야 합니다:
- 대실패: 파국적. 예상치 못하고 끔찍한 일이 발생. 새 위협, 치명적 손실, 핵심 정보 노출.
- 실패: 명확한 실패. 의미 있고 고통스러운 합병증. 플레이어가 더 불리해짐.
- 부분 성공: 달성됐지만 실제 대가. 상처, 불태운 인맥, 잃어버린 시간, 원치 않는 주목.
- 성공: 깔끔한 전진. 세계가 플레이어에게 유리하게 기움.
- 대성공: 기대 이상. 예상치 못한 이점, 폭로, 존재해서는 안 될 기회.

═══ 스탯 시스템 ═══
범위: hp 0~maxHp, 나머지 1~10.
- hp: -25~+15 (위험을 진짜로 유지 — 회복은 쟁취해야 함)
- strength/cunning/will: ±1 (진정한 성장 순간에만)
- reputation: ±1~±2 (중요한 사회적 행동)
- hp가 0이 되면: isEnding: true, 사망 장면

═══ 적 시스템 ═══
전투는 생생하고 구체적입니다. 일반적인 적 금지:
- 이름은 세계를 반영해야 합니다: "흑요석 조합의 불씨턱 집행관", "브레시안 무효기사", "자신의 이름을 잊어버린 간수"
- 적 오브젝트에는 반드시 "name" (영어/로마자) AND "nameKo" (한국어) 두 필드를 모두 포함하세요.
- 예시: "name": "Cinder-Jaw Enforcer", "nameKo": "불씨턱 집행관"
- 적 스탯: hp 25~100, attack 4~12, defense 1~8
- 주사위 결과별 HP 변화:
  대성공: 적 -22~-35 | 성공: 적 -10~-20
  부분 성공: 적 -4~-10 AND 플레이어 -6~-14
  실패: 적 변화 없음 AND 플레이어 -10~-18
  대실패: 적 변화 없음 AND 플레이어 -16~-28
- 적 hp가 0이 되면: inCombat: false, enemy: null, 처치 서술
- 전투 중: "enemyChanges": { "hp": <변화량> } 포함
- 전투 중이 아닐 때: inCombat: false, enemy: null

═══ 아이템 시스템 ═══
"itemsGained": [...] 를 통해 서사적으로 획득했을 때 아이템을 부여하세요. 턴당 최대 2개.
아이템은 찾을 수 있어야 합니다 — 세계 곳곳에 있습니다. 소모품과 장비는 생존의 기본 통화입니다.

드롭 규칙 — 반드시 따르세요:

  탐험 & 파밍 (방 수색, 시체 뒤지기, 폐허, 상자, 숨겨진 공간 등)
  → 75% 확률: 소모품 1개 지급 (붕대, 물약, 식량, 연료, 연고 — 세계관에 맞게)
  → 30% 확률: 추가로 장비 1개 지급 (낡은 칼, 금 간 방패, 오래된 반지 — 세계관에 맞게)
  → 항상 확인: 플레이어가 무언가를 수색하거나 파밍했는가? 그렇다면 확률적으로 지급하세요.

  전투 승리 (적 hp가 0이 됐을 때)
  → 65% 확률: 적의 몸에서 소모품 1개 지급 (적 유형과 세계관에 맞게)
  → 30% 확률: 추가로 적이 사용하던 장비 1개 지급
  → 이름 있는 적이나 보스급 적은 반드시 아이템 최소 1개 드롭

  NPC 상호작용 (거래, 뇌물, 매력, 심문, 도움, 퀘스트 완료)
  → 거래/뇌물 성공: 거래한 아이템 또는 동등한 것 지급
  → NPC가 감사하거나 인상받음: 60% 확률로 소모품 선물 (음식, 약, 도구)
  → 상점이나 물건을 가진 NPC: 40% 확률로 장비 1개 제공
  → NPC 요청 완료: 반드시 아이템 최소 1개 보상으로 지급

  특수 행동 (예외적인 주사위 결과, 창의적 해결, 대성공)
  → 탐험이나 사교 행동에서 대성공: 반드시 보너스 아이템 1개 지급
  → 비밀 구역이나 숨겨진 보관소 발견: 반드시 아이템 1~2개 지급

아이템 종류:
- "consumable": 1회 사용, 즉시 효과 (hp 회복/손상, 스탯 변화). 예: 치유 연고, 쓴 강장제, 각성제, 식량, 해독제, 붕대
- "equipment": 장착 중 지속 스탯 보너스. 예: 철제 건틀렛 (+2 strength), 도적의 반지 (+2 cunning), 낡은 부적 (+1 will)
- "key_item": 서사적 잠금 해제, 스탯 효과 없음. 희귀함 — 아래 핵심 아이템 시스템 참조. 예: 위조 통행증, 총독의 인장

아이템 JSON 형식 ("itemsGained" 배열에 포함):
{ "id": "고유_식별자", "name": "English Name", "nameKo": "한국어 이름", "description": "영어 설명.", "descriptionKo": "한국어 설명.", "type": "consumable|equipment|key_item", "rarity": "common|uncommon|rare|legendary", "icon": "이모지", "effect": {"hp":0,"strength":0,"cunning":0,"will":0,"reputation":0}, "quantity": 1, "situational": false, "condition": "" }

규칙: 이번 턴에 아이템을 부여하지 않으면 "itemsGained" 포함 불필요. 중복 아이템 금지 (인벤토리 먼저 확인).

═══ 핵심 아이템 시스템 ═══
핵심 아이템은 극도로 희귀합니다 — 이야기의 결정적이고 대체 불가능한 전환점에서만 부여하세요 (최대 10턴당 1개, 플롯이 필요로 할 때만).
탐험 파밍이나 NPC 보상으로 절대 지급하지 마세요 — 반드시 주요 스토리 분기점에서 얻어진 것으로 느껴져야 합니다.
수동적인 도구가 아닙니다. 좁고 특정한 기회의 창을 열어줍니다.

"condition" 필드: 이 아이템이 유용해지는 유일한 순간을 정확히 설명하는 2~4개의 키워드.
  ✓ "감옥,독방,철창,탈출" — 감옥을 탈출하거나 근처에 있을 때만 사용 가능
  ✓ "봉인된_문,금고,암호화된_자물쇠" — 특정 잠긴 장소에서만 사용 가능
  ✓ "수배,검문소,위병_검사" — 공식 검문소를 통과할 때만 사용 가능
  ✗ "위험한" 또는 "적"처럼 너무 광범위한 조건 사용 금지

핵심 아이템 활성화 (조건 충족 시 필수):
매 턴 플레이어의 인벤토리를 점검하세요. 키 아이템의 조건 키워드가 현재 장면과 일치하면:
  1. 해당 아이템의 id와 매력적인 선택지 텍스트를 "keyItemChoices"에 포함
  2. 플레이어는 기본 3가지 선택지와 함께 이 추가 선택지를 볼 수 있음
  3. 지금 아니면 절대 사용 불가 — 선택하지 않으면 다음 턴에 영구히 소멸됨
  4. 선택지 텍스트를 생생하고 결과적으로 작성: 이것을 사용하면 어떤 극적인 행동이 가능한지 설명
  5. 턴당 최대 1개의 핵심 아이템만 활성화 가능

"keyItemChoices" 형식:
[{"itemId": "인벤토리의_정확한_아이템_id", "choiceText": "[아이템 이름] 사용: 행동 생생한 묘사"}]

이번 장면에 일치하는 핵심 아이템 조건 없음 → "keyItemChoices": []

═══ 스킬 선택지 ═══
매 턴, 사용자 메시지에 "사용 가능한 스킬 (준비 완료)" 목록이 제공됩니다. 반드시 확인하세요.
해당 스킬이 기존 3가지 선택지로는 불가능한 고유한 서사적 행동을 가능하게 한다면, "skillChoices"에 항목 1개를 추가하세요.

규칙:
- 턴당 최대 1개의 스킬 선택지
- 그 스킬 없이는 불가능한 행동이어야 함 (단순히 선택지 1번의 강화판이 아닌)
- 현재 장면에 맞는 구체적인 행동을 묘사 — 항상 장면별 맞춤, 일반적 설명 금지
- 직전 턴과 같은 스킬 선택지 반복 금지 (장면이 강하게 요구하지 않는 한)
- 모든 스킬이 쿨다운 중이면 스킬 선택지 제공 금지
- 전투 중에는 스킬 선택지 제공 금지 — 전투 시스템이 담당

좋은 스킬 선택지 예시:
  ✓ 자물쇠 따기 → 경보 없이 잠긴 문/금고 우회
  ✓ 전투의 함성 → 전투 시작 전 적의 사기를 완전히 꺾어 싸움을 막음
  ✓ 은빛 혀 → 절대 공유하지 않을 정보를 NPC에게서 끌어냄
  ✓ 마법 시야 → 숨겨진 함정, 비밀 통로, 위장한 적 탐지
  ✓ 위장 → 군중 속을 완전히 은폐된 채로 대상 추적
  ✓ 어둠의 의식 → 일반적인 방법으로는 접근 불가한 금지된 지식 발굴
  ✓ 자연과 교감 → 환경 자체에 숨겨진 경로나 위험 정보 요청
  ✗ 금지: "전투의 함성으로 공격" (그냥 전투임)
  ✗ 금지: "스킬을 써서 더 잘 굴림" (의미 없음)

"skillChoices" 형식: [{"skillId": "<AVAILABLE_SKILLS의_정확한_id>", "choiceText": "이 스킬이 가능하게 하는 고유 행동의 생생하고 장면별 묘사"}]
적합한 스킬 없음 → "skillChoices": []

마크다운 없이 유효한 JSON만 응답:
{
  "narration": "...",
  "choices": ["...", "...", "..."],
  "statChanges": { "hp": 0, "strength": 0, "cunning": 0, "will": 0, "reputation": 0 },
  "worldConsequences": { "hp": 0, "strength": 0, "cunning": 0, "will": 0, "reputation": 0 },
  "worldConsequenceDesc": "",
  "isEnding": false,
  "goalAchieved": false,
  "inCombat": false,
  "enemy": null,
  "enemyChanges": { "hp": 0 },
  "itemsGained": [],
  "worldEvents": [],
  "keyItemChoices": [],
  "skillChoices": [],
  "goal": "(첫 번째 응답에서만)",
  "goalShort": "(첫 번째 응답에서만)"
}`;

const OUTCOME_CONTEXT_EN: Record<DiceOutcome, string> = {
  critical_failure: "CRITICAL FAILURE — everything goes catastrophically wrong",
  failure:          "FAILURE — the attempt clearly fails, a new problem emerges",
  partial:          "PARTIAL SUCCESS — partial achievement with a cost or complication",
  success:          "SUCCESS — the action works as intended",
  critical_success: "CRITICAL SUCCESS — exceptional outcome, something extra happens",
};

const OUTCOME_CONTEXT_KO: Record<DiceOutcome, string> = {
  critical_failure: "대실패 — 모든 것이 최악으로 흘러갑니다",
  failure:          "실패 — 시도가 명확히 실패하고, 새 문제가 발생합니다",
  partial:          "부분 성공 — 일부 달성, 하지만 대가나 복잡한 상황이 따릅니다",
  success:          "성공 — 행동이 의도대로 효과를 발휘합니다",
  critical_success: "대성공 — 탁월한 결과, 예상 밖의 행운이 따릅니다",
};

// ─── Class starting stats ─────────────────────────────────────────────────────

const CLASS_STATS: Record<string, Stats> = {
  Warrior:     { hp: 100, maxHp: 100, strength: 8, cunning: 3, will: 4, reputation: 5 },
  Rogue:       { hp:  70, maxHp:  70, strength: 4, cunning: 9, will: 3, reputation: 3 },
  Mage:        { hp:  60, maxHp:  60, strength: 2, cunning: 6, will: 9, reputation: 5 },
  Paladin:     { hp:  90, maxHp:  90, strength: 7, cunning: 3, will: 8, reputation: 7 },
  Ranger:      { hp:  80, maxHp:  80, strength: 6, cunning: 7, will: 5, reputation: 4 },
  Necromancer: { hp:  65, maxHp:  65, strength: 3, cunning: 6, will: 8, reputation: 2 },
  Bard:        { hp:  70, maxHp:  70, strength: 3, cunning: 8, will: 6, reputation: 7 },
  Druid:       { hp:  75, maxHp:  75, strength: 5, cunning: 5, will: 8, reputation: 4 },
  Ironclad:   { hp: 110, maxHp: 110, strength: 8, cunning: 2, will: 5, reputation: 4 },
  Hexblade:   { hp:  68, maxHp:  68, strength: 5, cunning: 5, will: 8, reputation: 2 },
  Drifter:    { hp:  72, maxHp:  72, strength: 4, cunning: 8, will: 4, reputation: 6 },
  Alchemist:  { hp:  65, maxHp:  65, strength: 3, cunning: 9, will: 5, reputation: 4 },
  전사:         { hp: 100, maxHp: 100, strength: 8, cunning: 3, will: 4, reputation: 5 },
  도적:         { hp:  70, maxHp:  70, strength: 4, cunning: 9, will: 3, reputation: 3 },
  마법사:       { hp:  60, maxHp:  60, strength: 2, cunning: 6, will: 9, reputation: 5 },
  성기사:       { hp:  90, maxHp:  90, strength: 7, cunning: 3, will: 8, reputation: 7 },
  레인저:       { hp:  80, maxHp:  80, strength: 6, cunning: 7, will: 5, reputation: 4 },
  사령술사:     { hp:  65, maxHp:  65, strength: 3, cunning: 6, will: 8, reputation: 2 },
  음유시인:     { hp:  70, maxHp:  70, strength: 3, cunning: 8, will: 6, reputation: 7 },
  드루이드:     { hp:  75, maxHp:  75, strength: 5, cunning: 5, will: 8, reputation: 4 },
  철갑전사:     { hp: 110, maxHp: 110, strength: 8, cunning: 2, will: 5, reputation: 4 },
  저주검사:     { hp:  68, maxHp:  68, strength: 5, cunning: 5, will: 8, reputation: 2 },
  방랑자:       { hp:  72, maxHp:  72, strength: 4, cunning: 8, will: 4, reputation: 6 },
  연금술사:     { hp:  65, maxHp:  65, strength: 3, cunning: 9, will: 5, reputation: 4 },
};

const DEFAULT_STATS: Stats = { hp: 75, maxHp: 75, strength: 5, cunning: 5, will: 5, reputation: 5 };

function applyStatChanges(stats: Stats, changes: StatChanges): Stats {
  const r = { ...stats };
  if (changes.hp !== undefined)         r.hp         = Math.max(0, Math.min(r.maxHp, r.hp + changes.hp));
  if (changes.strength !== undefined)   r.strength   = Math.max(1, Math.min(10, r.strength + changes.strength));
  if (changes.cunning !== undefined)    r.cunning    = Math.max(1, Math.min(10, r.cunning + changes.cunning));
  if (changes.will !== undefined)       r.will       = Math.max(1, Math.min(10, r.will + changes.will));
  if (changes.reputation !== undefined) r.reputation = Math.max(1, Math.min(10, r.reputation + changes.reputation));
  return r;
}

function tickSkillCooldowns(skills: Skill[]): Skill[] {
  return skills.map(s => ({ ...s, currentCooldown: Math.max(0, s.currentCooldown - 1) }));
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /skill-pool — return the skill pool for a class annotated with available/locked
router.get("/skill-pool", (req, res) => {
  const { characterClass = "", lang = "en", str, cun, wil, rep } = req.query as Record<string, string>;
  const classEn = KO_TO_EN[characterClass] ?? characterClass;
  let stats: Stats = CLASS_STATS[characterClass] || CLASS_STATS[classEn] || DEFAULT_STATS;
  // Allow caller to pass computed stats (e.g. from background questions)
  if (str || cun || wil || rep) {
    const pStr = str ? parseInt(str) : NaN;
    const pCun = cun ? parseInt(cun) : NaN;
    const pWil = wil ? parseInt(wil) : NaN;
    const pRep = rep ? parseInt(rep) : NaN;
    stats = {
      ...stats,
      strength:   !isNaN(pStr) ? pStr : stats.strength,
      cunning:    !isNaN(pCun) ? pCun : stats.cunning,
      will:       !isNaN(pWil) ? pWil : stats.will,
      reputation: !isNaN(pRep) ? pRep : stats.reputation,
    };
  }
  const pool = getClassSkillPool(characterClass);
  const annotated = pool.map(s => ({
    ...s,
    available: !s.statRequirement || stats[s.statRequirement.stat] >= s.statRequirement.min,
  }));
  res.json({ skills: annotated });
});

router.post("/start", async (req, res) => {
  try {
    const { genre = "fantasy", characterClass, playerName, lang = "en", skillIds, customStats, backgroundAnswers } = req.body;
    const title = playerName ? `${playerName}'s Chronicle` : "Chronicle";

    const [session] = await db.insert(gameSessions).values({ title, genre }).returning();

    const classStr: string = characterClass || "";
    const baseStats: Stats = CLASS_STATS[classStr] || DEFAULT_STATS;
    const startingStats: Stats = customStats
      ? {
          hp:         customStats.hp         ?? baseStats.hp,
          maxHp:      customStats.maxHp      ?? customStats.hp ?? baseStats.maxHp,
          strength:   Math.min(10, Math.max(1, customStats.strength   ?? baseStats.strength)),
          cunning:    Math.min(10, Math.max(1, customStats.cunning    ?? baseStats.cunning)),
          will:       Math.min(10, Math.max(1, customStats.will       ?? baseStats.will)),
          reputation: Math.min(10, Math.max(1, customStats.reputation ?? baseStats.reputation)),
        }
      : baseStats;
    const pool = getClassSkillPool(classStr);
    // Use player-selected skills if provided (validated: max 2, must exist in pool, must be available)
    let skills: Skill[];
    if (Array.isArray(skillIds) && skillIds.length >= 1) {
      const validIds = (skillIds as string[]).slice(0, 2).filter(id => {
        const s = pool.find(p => p.id === id);
        return s && (!s.statRequirement || startingStats[s.statRequirement.stat] >= s.statRequirement.min);
      });
      skills = pickSkillsFromIds(pool, validIds);
    } else {
      // Fallback: auto-pick first 2 available skills
      skills = pool.filter(s => !s.statRequirement || startingStats[s.statRequirement.stat] >= s.statRequirement.min).slice(0, 2);
    }

    statsMap.set(session.id, { ...startingStats });
    enemyMap.set(session.id, null);
    inventoryMap.set(session.id, []);

    const systemPrompt = lang === "ko" ? SYSTEM_PROMPT_KO : SYSTEM_PROMPT_EN;
    const skillsInfo = skills.map(s =>
      `${lang === "ko" ? s.nameKo : s.name}: ${lang === "ko" ? s.descriptionKo : s.description}`
    ).join("; ");

    // Build backstory block from background answers
    const bgPairs: Array<{ question: string; answer: string }> = Array.isArray(backgroundAnswers) ? backgroundAnswers : [];
    const backstoryBlock = bgPairs.length > 0
      ? (lang === "ko"
          ? `\n\n[플레이어 과거 — 이것을 개막 서사에 자연스럽게 녹여낼 것. 직접 나열하지 말고 내러티브로 암시하거나 회상으로 스며들게 할 것]\n` +
            bgPairs.map((p, i) => `${i + 1}. ${p.question} → ${p.answer}`).join("\n")
          : `\n\n[Player Backstory — weave this into the opening scene naturally. Do NOT list them. Let them surface as memories, scars, habits, or implicit context that bleeds into the prose]\n` +
            bgPairs.map((p, i) => `${i + 1}. ${p.question} → ${p.answer}`).join("\n"))
      : "";

    const openingPrompt = lang === "ko"
      ? `장르 톤: ${genre}
캐릭터 역할(행동 방식 렌즈, 세계 설정이 아님): ${classStr || "모험가"}
스탯: HP ${startingStats.hp}/${startingStats.maxHp}, 힘 ${startingStats.strength}, 교활 ${startingStats.cunning}, 의지 ${startingStats.will}, 명성 ${startingStats.reputation}
스킬: ${skillsInfo}${backstoryBlock}

[세계관 지시]
직업과 무관하게 완전히 새로운 세계와 시나리오를 창조하세요. 이 직업이 전혀 어울리지 않아 보이는 곳이면 더욱 좋습니다.
다중 단계가 필요한 복잡한 최종 목표("goal", "goalShort")를 정의하되 — 서사에서 직접 언급하지 마세요.

[개막 지시 — 반드시 준수]
• 위기나 전투로 시작하지 마세요. 플레이어는 지금 어딘가에 있고, 세계는 아직 고요합니다.
• 장소를 감각적으로 구체화하세요. 무엇이 보이고 냄새나고 들리는가?
• 세계 어딘가 뭔가 미세하게 잘못됐음을 보여주세요 — 설명 없이. 복선입니다.
• 플레이어의 과거가 그들의 행동 방식이나 알아채는 것에 자연스럽게 묻어나게 하세요 (설명 금지).
• 플레이어가 왜 이 장소에 있게 됐는지를 서사 속 분위기와 암시로 드러내세요.

[첫 선택지 규칙 — 반드시 준수]
선택지 A: 주변에서 이상하거나 눈에 걸리는 것을 더 자세히 살피기
선택지 B: 근처 인물에게 접근하거나 조용히 관찰하기
선택지 C: 이야기가 이어질 다음 장소로 이동하기
→ 세 선택지 모두 탐색/관찰 중심이어야 합니다. 전투나 도주 금지.`
      : `Genre tone: ${genre}
Character role (action-style lens, NOT world setting): ${classStr || "Adventurer"}
Stats: HP ${startingStats.hp}/${startingStats.maxHp}, STR ${startingStats.strength}, CUN ${startingStats.cunning}, WIL ${startingStats.will}, REP ${startingStats.reputation}
Skills: ${skillsInfo}${backstoryBlock}

[World-building directive]
Ignore genre assumptions tied to the class. Build a completely original world — the more unexpected the combination, the better.
Define a complex multi-step final goal ("goal", "goalShort") — but do NOT state it in the narration itself.

[Opening scene directive — strictly enforced]
• Do NOT open in crisis, combat, or mid-chase. The player is somewhere. The world is still.
• Anchor the player in a specific, sensory location: what is seen, smelled, heard right now?
• Show one thing that is subtly wrong — a detail that doesn't fit, left unexplained. This is your foreshadowing seed.
• Let 1-2 elements of the player's past surface as reflex, habit, or what they notice — never as stated history.
• Explain through atmosphere and implication WHY the player is here, not through direct narration.

[First-turn choices — strictly enforced]
Choice A: Investigate something strange or out of place in the immediate environment
Choice B: Approach or quietly observe a nearby person who may know something
Choice C: Move toward the next location where the story will continue
→ All three must be observation/exploration oriented. No combat, no escape.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: openingPrompt }],
      response_format: { type: "json_object" },
      temperature: 1.0,
    });

    const raw = completion.choices[0].message.content ?? "{}";
    const data = safeParseJSON(raw);

    // Opening scene is NEVER in combat — override any AI mistakes
    data.inCombat     = false;
    data.enemy        = null;
    data.enemyChanges = { hp: 0 };

    // Store goal in player meta
    const goal      = data.goal      ?? (lang === "ko" ? "알 수 없는 목표" : "Complete your mission");
    const goalShort = data.goalShort ?? (lang === "ko" ? "임무를 완수하라" : "Complete your mission");
    playerMetas.set(session.id, { name: playerName || "", characterClass: classStr, skills, goal, goalShort });

    const startState = {
      stats: startingStats,
      inventory: [],
      meta: { name: playerName || "", characterClass: classStr, skills, goal, goalShort },
      worldEvents: [],
      enemy: null,
    };
    await db.insert(storyEntries).values({
      sessionId: session.id, entryType: "narration",
      content: JSON.stringify({ ...data, _state: startState }),
    });

    res.json({ sessionId: session.id, stats: startingStats, skills, goal, goalShort, ...data });
  } catch (err) {
    req.log.error(err, "Error starting game");
    res.status(500).json({ error: "Failed to start game" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid session id" });
    const [session] = await db.select().from(gameSessions).where(eq(gameSessions.id, id));
    if (!session) return res.status(404).json({ error: "Session not found" });

    const entries = await db.select().from(storyEntries).where(eq(storyEntries.sessionId, id));

    // Reconstruct all in-memory state from last _state snapshot (after server restart)
    if (!statsMap.has(id)) {
      const lastNarration = [...entries].reverse().find(e => e.entryType === "narration");
      if (lastNarration) {
        try {
          const d = JSON.parse(lastNarration.content);
          if (d._state) {
            if (d._state.stats)                          statsMap.set(id, d._state.stats);
            if (d._state.inventory)                      inventoryMap.set(id, d._state.inventory);
            if (d._state.meta)                           playerMetas.set(id, d._state.meta);
            if (d._state.enemy !== undefined)            enemyMap.set(id, d._state.enemy);
            if (Array.isArray(d._state.worldEvents))     worldEventsMap.set(id, d._state.worldEvents);
            if (d._state.statusEffects)                  statusEffectsMap.set(id, d._state.statusEffects);
          }
        } catch { /* ignore bad entries */ }
      }
    }
    if (!worldEventsMap.has(id)) {
      worldEventsMap.set(id, reconstructWorldEvents(entries));
    }

    const baseStats  = statsMap.get(id) || DEFAULT_STATS;
    const inventory  = inventoryMap.get(id) ?? [];
    const stats      = applyEquipmentBonuses(baseStats, inventory);
    const playerMeta = playerMetas.get(id);
    const enemy      = enemyMap.get(id) ?? null;
    const worldEvents = worldEventsMap.get(id) ?? [];

    res.json({ session, entries, stats, playerMeta, enemy, inventory, worldEvents });
  } catch (err) {
    req.log.error(err, "Error fetching game");
    res.status(500).json({ error: "Failed to fetch game" });
  }
});

router.post("/:id/choice", async (req, res) => {
  const sessionId = parseInt(req.params.id);
  if (isNaN(sessionId)) return res.status(400).json({ error: "Invalid session id" });
  if (inFlightSessions.has(sessionId)) return res.status(429).json({ error: "Request already in progress" });
  inFlightSessions.add(sessionId);
  try {
    const { choiceIndex, choiceText, lang = "en", skillId, keyItemId } = req.body;

    const [session] = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
    if (!session) return res.status(404).json({ error: "Session not found" });

    const baseStats = statsMap.get(sessionId) || DEFAULT_STATS;
    let inventory   = inventoryMap.get(sessionId) ?? [];
    const meta      = playerMetas.get(sessionId);
    let skills      = meta?.skills ?? [];

    // ── Key item now-or-never: expire items offered last turn if player didn't use one ──
    const pendingKeyItems = pendingKeyItemsMap.get(sessionId) ?? [];
    let expiredKeyItemNames: string[] = [];
    if (pendingKeyItems.length > 0 && !keyItemId) {
      // Player didn't use any key item — remove all pending ones permanently
      expiredKeyItemNames = inventory
        .filter(i => pendingKeyItems.includes(i.id))
        .map(i => lang === "ko" ? i.nameKo : i.name);
      inventory = inventory.filter(i => !pendingKeyItems.includes(i.id));
      inventoryMap.set(sessionId, inventory);
    }
    pendingKeyItemsMap.delete(sessionId);

    // ── Handle key item choice: remove from inventory immediately ──
    let keyItemNote = "";
    if (keyItemId) {
      const usedKeyItem = inventory.find(i => i.id === keyItemId && i.type === "key_item");
      if (usedKeyItem) {
        inventory = inventory.filter(i => i.id !== keyItemId);
        inventoryMap.set(sessionId, inventory);
        const name = lang === "ko" ? usedKeyItem.nameKo : usedKeyItem.name;
        const desc = lang === "ko" ? usedKeyItem.descriptionKo : usedKeyItem.description;
        keyItemNote = lang === "ko"
          ? `\nKEY ITEM USED: "${name}" — ${desc}. 이 아이템은 소모되었습니다. 이 아이템 사용을 서사에 강하게 반영하세요.`
          : `\nKEY ITEM USED: "${name}" — ${desc}. Item consumed. Strongly reflect this item use in the narration.`;
      }
    }

    // Skill handling
    let skillBonus   = 0;
    let usedSkill: Skill | undefined;
    let skillHpEffect = 0;

    if (skillId) {
      usedSkill = skills.find(s => s.id === skillId && s.currentCooldown === 0);
      if (usedSkill) {
        skillBonus    = usedSkill.bonusValue;
        skillHpEffect = usedSkill.hpEffect ?? 0;
      }
    }

    // Apply skill HP effect to BASE stats (not effective)
    let newBaseStats = skillHpEffect !== 0
      ? applyStatChanges(baseStats, { hp: skillHpEffect })
      : { ...baseStats };

    // For dice rolling only: use effective stats (base + equipment stat bonuses)
    const statsForRoll = applyEquipmentBonuses(newBaseStats, inventory);
    const statsBeforeRoll = statsForRoll; // used in context message

    const roll       = computeRoll(choiceText as string, statsForRoll, skillBonus);
    const outcomeCtx = lang === "ko" ? OUTCOME_CONTEXT_KO[roll.outcome] : OUTCOME_CONTEXT_EN[roll.outcome];
    const currentEnemy = enemyMap.get(sessionId) ?? null;

    // Build message history
    const entries  = await db.select().from(storyEntries).where(eq(storyEntries.sessionId, sessionId));
    const systemPrompt = lang === "ko" ? SYSTEM_PROMPT_KO : SYSTEM_PROMPT_EN;
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    for (const entry of entries) {
      if (entry.entryType === "narration") {
        messages.push({ role: "assistant", content: entry.content });
      } else if (entry.entryType === "choice") {
        const cd = JSON.parse(entry.content);
        messages.push({ role: "user", content: cd.context ?? cd.text });
      }
    }

    const skillNote = usedSkill
      ? `\nSKILL USED: "${lang === "ko" ? usedSkill.nameKo : usedSkill.name}" — ${lang === "ko" ? usedSkill.descriptionKo : usedSkill.description} (roll modifier +${skillBonus})`
      : "";

    // Available skills (not on cooldown) — sent to AI for skill choice generation
    const availableSkills = skills.filter(s => s.currentCooldown === 0);
    const skillsNote = availableSkills.length > 0
      ? (lang === "ko"
          ? `\n사용 가능한 스킬 (준비 완료):\n${availableSkills.map(s => `- ${s.id} (${s.nameKo}): ${s.descriptionKo}`).join("\n")}`
          : `\nAVAILABLE SKILLS (ready to use):\n${availableSkills.map(s => `- ${s.id} (${s.name}): ${s.description}`).join("\n")}`)
      : (lang === "ko" ? "\n사용 가능한 스킬: 없음 (모두 쿨다운 중)" : "\nAVAILABLE SKILLS: none (all on cooldown)");

    const enemyNote = currentEnemy
      ? `\nCURRENT ENEMY: ${currentEnemy.name} (HP ${currentEnemy.hp}/${currentEnemy.maxHp}, ATK ${currentEnemy.attack}, DEF ${currentEnemy.defense})`
      : "";
    const goalNote  = meta?.goal
      ? `\nFINAL GOAL: ${meta.goal} (NOT YET ACHIEVED — do not end the story unless this is now truly complete)`
      : "";
    const inventoryNote = inventory.length > 0
      ? `\nINVENTORY: ${inventory.map(i => {
          const name = lang === "ko" ? i.nameKo : i.name;
          const condNote = i.type === "key_item" && i.condition ? `, usable when: "${i.condition}"` : "";
          return `${name} [${i.type}${i.equipped ? ", equipped" : ""}${condNote}] x${i.quantity}`;
        }).join(" | ")}`
      : "";
    const worldMemoryNote = buildWorldMemoryBlock(sessionId, lang);

    // Reputation tier label — tells the AI which NPC attitude tier to apply
    const repValue = statsBeforeRoll.reputation;
    const repTier = repValue <= 2
      ? (lang === "ko" ? "무명/의심" : "UNKNOWN/SUSPICIOUS")
      : repValue <= 4
        ? (lang === "ko" ? "중립" : "NEUTRAL")
        : repValue <= 6
          ? (lang === "ko" ? "알려짐/존경" : "KNOWN/RESPECTED")
          : repValue <= 8
            ? (lang === "ko" ? "유명/두려움" : "FAMOUS/FEARED")
            : (lang === "ko" ? "전설" : "LEGENDARY");
    const repTierNote = lang === "ko"
      ? `\n[NPC 태도 기준] 명성 단계: ${repTier} (REP ${repValue}) — 이번 장면의 모든 NPC는 이 단계로 행동해야 합니다.`
      : `\n[NPC ATTITUDE] REPUTATION TIER: ${repTier} (REP ${repValue}) — ALL NPCs in this scene must behave according to this tier.`;

    // All player skills (including on cooldown) — social skill awareness
    const allSkillIds = skills.map(s => lang === "ko" ? `${s.nameKo}(${s.id})` : `${s.name}(${s.id})`);
    const socialSkillNote = allSkillIds.length > 0
      ? (lang === "ko"
          ? `\n[사회 스킬 인식] 플레이어 보유 스킬: ${allSkillIds.join(", ")} — NPC는 이 스킬들의 분위기(위협, 설득, 카리스마 등)를 감지할 수 있습니다.`
          : `\n[SOCIAL SKILL AWARENESS] Player skills: ${allSkillIds.join(", ")} — NPCs may sense the nature of these abilities (threat, charm, dark power, etc).`)
      : "";

    // Active companions extracted from world events
    const worldEvtList = worldEventsMap.get(sessionId) ?? [];
    const companionEvents = worldEvtList.filter(e => /recruit|합류/i.test(e));
    const companionNote = companionEvents.length > 0
      ? (lang === "ko"
          ? `\n[현재 동료] ${companionEvents.join(" | ")} — 이들은 현재 장면에 존재하며 행동하고 의견을 표현합니다.`
          : `\n[ACTIVE COMPANIONS] ${companionEvents.join(" | ")} — they are present in the scene and contribute actions and opinions.`)
      : "";

    const userMsg = `Player chose option ${choiceIndex + 1}: "${choiceText}"${skillNote}${keyItemNote}\n\nDICE ROLL: ${outcomeCtx}\nRolled: d20=${roll.raw}, ${roll.stat.toUpperCase()} modifier=${roll.modifier > 0 ? "+" : ""}${roll.modifier}, Total=${roll.total}${enemyNote}${goalNote}${inventoryNote}${worldMemoryNote}${skillsNote}${repTierNote}${socialSkillNote}${companionNote}\nPlayer stats: HP ${statsBeforeRoll.hp}/${statsBeforeRoll.maxHp}, STR ${statsBeforeRoll.strength}, CUN ${statsBeforeRoll.cunning}, WIL ${statsBeforeRoll.will}, REP ${statsBeforeRoll.reputation}\nTurn: ${session.turnCount + 1}`;

    messages.push({ role: "user", content: userMsg });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      response_format: { type: "json_object" },
      temperature: 0.95,
    });

    const rawResp    = completion.choices[0].message.content ?? "{}";
    const data       = safeParseJSON(rawResp);
    const statChanges: StatChanges     = (data.statChanges as StatChanges)      || {};
    const worldConsequences: StatChanges = data.worldConsequences || {};
    const worldConsequenceDesc: string   = typeof data.worldConsequenceDesc === "string" ? data.worldConsequenceDesc : "";

    // Accumulate world events
    if (Array.isArray(data.worldEvents) && data.worldEvents.length > 0) {
      addWorldEvents(sessionId, data.worldEvents.filter((e: unknown) => typeof e === "string"), session.turnCount + 1);
    }

    // Store new pending key item choices (now-or-never, expires next turn)
    type KeyItemChoice = { itemId: string; choiceText: string };
    const newKeyItemChoices: KeyItemChoice[] = Array.isArray(data.keyItemChoices)
      ? data.keyItemChoices.filter((k: unknown): k is KeyItemChoice =>
          typeof k === "object" && k !== null &&
          typeof (k as KeyItemChoice).itemId === "string" &&
          typeof (k as KeyItemChoice).choiceText === "string" &&
          inventory.some(i => i.id === (k as KeyItemChoice).itemId)
        )
      : [];
    if (newKeyItemChoices.length > 0) {
      pendingKeyItemsMap.set(sessionId, newKeyItemChoices.map(k => k.itemId));
    }

    // Extract skill choices from AI response (validated against player's actual skills)
    type SkillChoiceRaw = { skillId: string; choiceText: string };
    const newSkillChoices: SkillChoiceRaw[] = Array.isArray(data.skillChoices)
      ? data.skillChoices.filter((sc: unknown): sc is SkillChoiceRaw =>
          typeof sc === "object" && sc !== null &&
          typeof (sc as SkillChoiceRaw).skillId === "string" &&
          typeof (sc as SkillChoiceRaw).choiceText === "string" &&
          skills.some(s => s.id === (sc as SkillChoiceRaw).skillId && s.currentCooldown === 0)
        ).slice(0, 1)
      : [];

    // Apply AI stat changes to BASE stats (not effective stats)
    newBaseStats = applyStatChanges(newBaseStats, statChanges);

    // Apply world consequence modifiers on top of stat changes
    const hasWorldConsequences = Object.values(worldConsequences).some(v => typeof v === "number" && v !== 0);
    if (hasWorldConsequences) {
      newBaseStats = applyStatChanges(newBaseStats, worldConsequences);
    }

    // Enforce ending rules: only end on death or goal achieved
    if (newBaseStats.hp <= 0) {
      data.isEnding    = true;
      data.goalAchieved = false;
    } else if (data.isEnding && !data.goalAchieved) {
      data.isEnding = false;
    }

    statsMap.set(sessionId, newBaseStats);

    // Handle items gained from AI response
    if (Array.isArray(data.itemsGained) && data.itemsGained.length > 0) {
      const updatedInventory = mergeItems(inventory, data.itemsGained);
      inventoryMap.set(sessionId, updatedInventory);
    }

    // Update enemy state — server owns HP tracking, never trust AI's hp field
    const aiHpDelta = typeof data.enemyChanges?.hp === "number" ? data.enemyChanges.hp : 0;
    let serverTrackedHp: number;
    if (currentEnemy === null && data.inCombat && data.enemy) {
      // New enemy entering combat — use AI's initial hp
      serverTrackedHp = Math.max(0, Math.round(Number(data.enemy.hp) || 0));
    } else if (currentEnemy !== null && data.inCombat) {
      // Ongoing combat — apply the delta reported by AI to our tracked value
      serverTrackedHp = Math.max(0, currentEnemy.hp + aiHpDelta);
    } else {
      serverTrackedHp = 0;
    }

    const newEnemy: Enemy | null = data.inCombat && data.enemy
      ? {
          name:    data.enemy.name    ?? currentEnemy?.name    ?? "Unknown",
          nameKo:  data.enemy.nameKo  ?? currentEnemy?.nameKo,
          hp:      serverTrackedHp,
          maxHp:   data.enemy.maxHp   ?? currentEnemy?.maxHp   ?? serverTrackedHp,
          attack:  data.enemy.attack  ?? currentEnemy?.attack  ?? 5,
          defense: data.enemy.defense ?? currentEnemy?.defense ?? 2,
        }
      : null;
    enemyMap.set(sessionId, newEnemy);

    // Skill cooldowns
    if (usedSkill) {
      skills = skills.map(s => s.id === usedSkill!.id ? { ...s, currentCooldown: s.cooldown } : s);
    }
    skills = tickSkillCooldowns(skills);
    if (meta) playerMetas.set(sessionId, { ...meta, skills });

    // Persist — include full state snapshot for server-restart recovery
    const choiceStateSnapshot = {
      stats:        newBaseStats,
      inventory:    inventoryMap.get(sessionId) ?? [],
      meta:         playerMetas.get(sessionId),
      worldEvents:  worldEventsMap.get(sessionId) ?? [],
      enemy:        enemyMap.get(sessionId) ?? null,
      statusEffects: statusEffectsMap.get(sessionId) ?? null,
    };
    await db.insert(storyEntries).values([
      { sessionId, entryType: "choice", content: JSON.stringify({ index: choiceIndex, text: choiceText, context: userMsg }) },
      { sessionId, entryType: "narration", content: JSON.stringify({ ...data, _state: choiceStateSnapshot }), choiceIndex },
    ]);

    await db.update(gameSessions)
      .set({ turnCount: session.turnCount + 1, updatedAt: new Date() })
      .where(eq(gameSessions.id, sessionId));

    const prevEnemyHp  = currentEnemy?.hp;
    const newEnemyHp   = newEnemy?.hp;
    const enemyHpDelta = (prevEnemyHp !== undefined && newEnemyHp !== undefined)
      ? newEnemyHp - prevEnemyHp
      : aiHpDelta;

    const totalStatChanges: StatChanges = { ...statChanges };
    if (skillHpEffect !== 0) totalStatChanges.hp = (totalStatChanges.hp ?? 0) + skillHpEffect;

    const finalInventory = inventoryMap.get(sessionId) ?? [];
    const effectiveStats = applyEquipmentBonuses(newBaseStats, finalInventory);

    res.json({
      ...data,
      roll,
      statChanges: totalStatChanges,
      worldConsequences: hasWorldConsequences ? worldConsequences : {},
      worldConsequenceDesc,
      stats: effectiveStats,
      skills,
      enemy: newEnemy,
      enemyChanges: { hp: enemyHpDelta },
      inCombat: !!data.inCombat,
      inventory: finalInventory,
      itemsGained: data.itemsGained ?? [],
      goalAchieved: !!data.goalAchieved,
      worldEvents: worldEventsMap.get(sessionId) ?? [],
      keyItemChoices: newKeyItemChoices,
      skillChoices: newSkillChoices,
      expiredKeyItemNames,
    });
  } catch (err) {
    req.log.error(err, "Error processing choice");
    res.status(500).json({ error: "Failed to process choice" });
  } finally {
    inFlightSessions.delete(sessionId);
  }
});

// ─── POST /:id/use-item ───────────────────────────────────────────────────────
router.post("/:id/use-item", async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    if (isNaN(sessionId)) return res.status(400).json({ error: "Invalid session id" });
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: "itemId required" });

    const baseStats = statsMap.get(sessionId) || DEFAULT_STATS;
    const inventory = inventoryMap.get(sessionId) ?? [];

    const idx = inventory.findIndex(i => i.id === itemId);
    if (idx === -1) return res.status(404).json({ error: "Item not found in inventory" });

    const item = inventory[idx];
    if (item.type !== "consumable") return res.status(400).json({ error: "Only consumable items can be used directly" });

    // Apply effect to base stats
    const newBaseStats = applyStatChanges(baseStats, item.effect || {});

    // Remove or decrement quantity
    let newInventory: Item[];
    if ((item.quantity ?? 1) <= 1) {
      newInventory = inventory.filter((_, i) => i !== idx);
    } else {
      newInventory = inventory.map((it, i) => i === idx ? { ...it, quantity: it.quantity - 1 } : it);
    }

    statsMap.set(sessionId, newBaseStats);
    inventoryMap.set(sessionId, newInventory);

    const effectiveStats = applyEquipmentBonuses(newBaseStats, newInventory);
    res.json({ stats: effectiveStats, inventory: newInventory });
  } catch (err) {
    req.log.error(err, "Error using item");
    res.status(500).json({ error: "Failed to use item" });
  }
});

// ─── POST /:id/equip-item ─────────────────────────────────────────────────────
router.post("/:id/equip-item", async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    if (isNaN(sessionId)) return res.status(400).json({ error: "Invalid session id" });
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: "itemId required" });

    const baseStats = statsMap.get(sessionId) || DEFAULT_STATS;
    const inventory = inventoryMap.get(sessionId) ?? [];

    const idx = inventory.findIndex(i => i.id === itemId);
    if (idx === -1) return res.status(404).json({ error: "Item not found in inventory" });

    if (inventory[idx].type !== "equipment") {
      return res.status(400).json({ error: "Only equipment items can be equipped" });
    }

    const newInventory = inventory.map((it, i) =>
      i === idx ? { ...it, equipped: !it.equipped } : it
    );

    inventoryMap.set(sessionId, newInventory);
    const effectiveStats = applyEquipmentBonuses(baseStats, newInventory);
    res.json({ stats: effectiveStats, inventory: newInventory });
  } catch (err) {
    req.log.error(err, "Error equipping item");
    res.status(500).json({ error: "Failed to equip item" });
  }
});

// ─── POST /:id/use-key-item ───────────────────────────────────────────────────
router.post("/:id/use-key-item", async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    if (isNaN(sessionId)) return res.status(400).json({ error: "Invalid session id" });
    const { itemId, lang = "en" } = req.body;
    if (!itemId) return res.status(400).json({ error: "itemId required" });

    const [session] = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
    if (!session) return res.status(404).json({ error: "Session not found" });

    const baseStats = statsMap.get(sessionId) || DEFAULT_STATS;
    const inventory = inventoryMap.get(sessionId) ?? [];
    const meta      = playerMetas.get(sessionId);

    const idx = inventory.findIndex(i => i.id === itemId);
    if (idx === -1) return res.status(404).json({ error: "Item not found in inventory" });

    const item = inventory[idx];
    if (item.type !== "key_item") return res.status(400).json({ error: "Only key items can be used this way" });

    // Build message history
    const entries = await db.select().from(storyEntries).where(eq(storyEntries.sessionId, sessionId));
    const systemPrompt = lang === "ko" ? SYSTEM_PROMPT_KO : SYSTEM_PROMPT_EN;
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];

    for (const entry of entries) {
      if (entry.entryType === "narration") {
        messages.push({ role: "assistant", content: entry.content });
      } else if (entry.entryType === "choice") {
        const cd = JSON.parse(entry.content);
        messages.push({ role: "user", content: cd.context ?? cd.text });
      }
    }

    const itemName = lang === "ko" ? item.nameKo : item.name;
    const itemDesc = lang === "ko" ? item.descriptionKo : item.description;
    const userMsg  = lang === "ko"
      ? `플레이어가 핵심 아이템을 사용했습니다: "${itemName}" — ${itemDesc}. 이 아이템을 사용한 것이 스토리에 중요한 영향을 미칩니다. 다이스 굴림 없이 서사적 결과를 묘사하세요.`
      : `Player used key item: "${itemName}" — ${itemDesc}. This item usage has significant narrative impact. Describe the outcome without a dice roll — no DICE ROLL needed for this action.`;

    messages.push({ role: "user", content: userMsg });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      response_format: { type: "json_object" },
      temperature: 0.95,
    });

    const rawResp = completion.choices[0].message.content ?? "{}";
    const data    = safeParseJSON(rawResp);
    const statChanges: StatChanges = (data.statChanges as StatChanges) || {};

    const newBaseStats = applyStatChanges(baseStats, statChanges);

    // Remove key item after use
    const newInventory = inventory.filter((_, i) => i !== idx);

    statsMap.set(sessionId, newBaseStats);
    inventoryMap.set(sessionId, newInventory);

    // Merge any new items gained
    const finalInventory = Array.isArray(data.itemsGained) && data.itemsGained.length > 0
      ? mergeItems(newInventory, data.itemsGained)
      : newInventory;
    if (Array.isArray(data.itemsGained) && data.itemsGained.length > 0) {
      inventoryMap.set(sessionId, finalInventory);
    }

    const currentEnemy = enemyMap.get(sessionId) ?? null;
    const aiHpDelta    = typeof data.enemyChanges?.hp === "number" ? data.enemyChanges.hp : 0;
    const serverEnemy  = currentEnemy !== null && data.inCombat
      ? { ...currentEnemy, hp: Math.max(0, currentEnemy.hp + aiHpDelta) }
      : data.inCombat && data.enemy
        ? { ...data.enemy, hp: Math.max(0, Number(data.enemy.hp) || 0) }
        : null;
    enemyMap.set(sessionId, serverEnemy);

    // Persist — include full state snapshot for server-restart recovery
    const keyItemStateSnapshot = {
      stats:       newBaseStats,
      inventory:   inventoryMap.get(sessionId) ?? [],
      meta:        playerMetas.get(sessionId),
      worldEvents: worldEventsMap.get(sessionId) ?? [],
      enemy:       enemyMap.get(sessionId) ?? null,
    };
    await db.insert(storyEntries).values([
      { sessionId, entryType: "choice", content: JSON.stringify({ text: `[Key Item: ${itemName}]`, context: userMsg }) },
      { sessionId, entryType: "narration", content: JSON.stringify({ ...data, _state: keyItemStateSnapshot }), choiceIndex: -1 },
    ]);
    await db.update(gameSessions)
      .set({ turnCount: session.turnCount + 1, updatedAt: new Date() })
      .where(eq(gameSessions.id, sessionId));

    const effectiveStats = applyEquipmentBonuses(newBaseStats, finalInventory);
    res.json({
      ...data,
      stats: effectiveStats,
      inventory: finalInventory,
      enemy: serverEnemy,
      inCombat: !!data.inCombat,
      itemsGained: data.itemsGained ?? [],
    });
  } catch (err) {
    req.log.error(err, "Error using key item");
    res.status(500).json({ error: "Failed to use key item" });
  }
});

// ─── Combat system ────────────────────────────────────────────────────────────

type StatusEffectId = "stun" | "burn" | "poison" | "bleed" | "decay" | "weakened";
type StatusEffect = {
  id: StatusEffectId;
  name: string;
  nameKo: string;
  damagePerTurn: number;
  atkMod: number;
  defMod: number;
  duration: number;
};

type CombatSfx = { player: StatusEffect[]; enemy: StatusEffect[] };

const statusEffectsMap = new Map<number, CombatSfx>();

const STATUS_TEMPLATES: Record<StatusEffectId, Omit<StatusEffect, "duration">> = {
  stun:     { id: "stun",     name: "Stunned",   nameKo: "기절",    damagePerTurn: 0,  atkMod: 0,  defMod: 0  },
  burn:     { id: "burn",     name: "Burning",   nameKo: "화상",    damagePerTurn: 4,  atkMod: 0,  defMod: 0  },
  poison:   { id: "poison",   name: "Poisoned",  nameKo: "중독",    damagePerTurn: 3,  atkMod: 0,  defMod: 0  },
  bleed:    { id: "bleed",    name: "Bleeding",  nameKo: "출혈",    damagePerTurn: 2,  atkMod: 0,  defMod: 0  },
  decay:    { id: "decay",    name: "Decaying",  nameKo: "부식",    damagePerTurn: 0,  atkMod: -2, defMod: -2 },
  weakened: { id: "weakened", name: "Weakened",  nameKo: "약화",    damagePerTurn: 0,  atkMod: -2, defMod: 0  },
  torment:  { id: "torment",  name: "Tormented", nameKo: "고통",    damagePerTurn: 0,  maxHpPercent: 5, atkMod: 0, defMod: 0 },
};

function makeStatus(id: StatusEffectId, duration: number): StatusEffect {
  return { ...STATUS_TEMPLATES[id], duration };
}

type CombatSkillFx = {
  bonusDamage:      number;
  selfDamage?:      number;
  selfHeal?:        number;
  skipCA?:          boolean;
  drainRatio?:      number;
  piercing?:        number;
  reflect?:         number;                                     // reflects X flat damage back to enemy when they attack
  enemyDefReduce?:  number;                                     // permanently lowers enemy.defense by X
  defenseScaling?:  number;                                     // bonus damage += floor(enemy.defense * defenseScaling)
  invertDamage?:    boolean;                                    // enemy attack heals you instead of dealing damage
  statusOnEnemy?:   { id: StatusEffectId; duration: number };
  statusOnEnemy2?:  { id: StatusEffectId; duration: number };   // second simultaneous status on enemy
};

const COMBAT_SKILL_FX: Record<string, CombatSkillFx> = {
  // ── Warrior ──────────────────────────────────────────────────────────────────
  battle_cry:          { bonusDamage: 3, skipCA: true,  statusOnEnemy: { id: "stun",     duration: 1 } },
  berserker_rage:      { bonusDamage: 12, selfDamage: 8 },
  iron_skin:           { bonusDamage: 0,  selfHeal: 15, skipCA: true },
  last_stand:          { bonusDamage: 0,  selfHeal: 20, skipCA: true },
  soldier_instinct:    { bonusDamage: 0,  skipCA: true, enemyDefReduce: 3 },
  warlord_presence:    { bonusDamage: 0,  skipCA: true, statusOnEnemy: { id: "weakened", duration: 3 }, reflect: 4 },
  // ── Rogue ────────────────────────────────────────────────────────────────────
  shadow_strike:       { bonusDamage: 7,  skipCA: true, statusOnEnemy: { id: "bleed",    duration: 3 } },
  smoke_bomb:          { bonusDamage: 0,  skipCA: true, statusOnEnemy: { id: "stun",     duration: 2 }, statusOnEnemy2: { id: "poison", duration: 2 } },
  vanish:              { bonusDamage: 0,  selfHeal: 8,  skipCA: true },
  street_tough:        { bonusDamage: 0,  selfHeal: 12 },
  lockpick:            { bonusDamage: 0,  skipCA: true, enemyDefReduce: 5 },
  silver_tongue:       { bonusDamage: 0,  skipCA: true, statusOnEnemy: { id: "weakened", duration: 3 } },
  // ── Mage ─────────────────────────────────────────────────────────────────────
  arcane_surge:        { bonusDamage: 8,  statusOnEnemy: { id: "burn",     duration: 2 } },
  chain_lightning:     { bonusDamage: 10, statusOnEnemy: { id: "stun",     duration: 1 } },
  mana_shield:         { bonusDamage: 0,  selfHeal: 10, skipCA: true, reflect: 5 },
  spell_recovery:      { bonusDamage: 0,  selfHeal: 18, skipCA: true },
  arcane_sight:        { bonusDamage: 0,  skipCA: true, enemyDefReduce: 4 },
  enchanting_words:    { bonusDamage: 0,  skipCA: true, statusOnEnemy: { id: "weakened", duration: 3 } },
  // ── Paladin ──────────────────────────────────────────────────────────────────
  holy_strike:         { bonusDamage: 7,  statusOnEnemy: { id: "burn",     duration: 2 } },
  divine_smite:        { bonusDamage: 13 },
  lay_on_hands:        { bonusDamage: 0,  selfHeal: 22 },
  divine_protection:   { bonusDamage: 0,  selfHeal: 15, skipCA: true, reflect: 6 },
  judgement:           { bonusDamage: 4,  enemyDefReduce: 3, statusOnEnemy: { id: "weakened", duration: 2 } },
  blessed_presence:    { bonusDamage: 0,  skipCA: true, reflect: 8 },
  // ── Ranger ───────────────────────────────────────────────────────────────────
  precision_shot:      { bonusDamage: 5,  piercing: 4,  statusOnEnemy: { id: "bleed",    duration: 3 } },
  volley:              { bonusDamage: 7,  statusOnEnemy: { id: "bleed",    duration: 2 } },
  beast_bond:          { bonusDamage: 5,  skipCA: true },
  camouflage:          { bonusDamage: 0,  selfHeal: 8,  skipCA: true },
  trackmaster:         { bonusDamage: 0,  skipCA: true, enemyDefReduce: 4 },
  hunters_mark:        { bonusDamage: 4,  piercing: 2,  statusOnEnemy: { id: "decay",    duration: 2 } },
  // ── Necromancer ──────────────────────────────────────────────────────────────
  soul_drain:          { bonusDamage: 5,  drainRatio: 0.6 },
  deaths_embrace:      { bonusDamage: 5,  statusOnEnemy: { id: "torment",  duration: 3 } },
  bone_ward:           { bonusDamage: 0,  invertDamage: true },
  undying:             { bonusDamage: 0,  selfHeal: 22, skipCA: true },
  dark_ritual:         { bonusDamage: 0,  skipCA: true, statusOnEnemy: { id: "decay",    duration: 2 }, statusOnEnemy2: { id: "weakened", duration: 2 } },
  terrifying_visage:   { bonusDamage: 0,  skipCA: true, statusOnEnemy: { id: "stun",     duration: 1 }, statusOnEnemy2: { id: "weakened", duration: 2 } },
  // ── Bard ─────────────────────────────────────────────────────────────────────
  dissonant_whisper:   { bonusDamage: 4,  skipCA: true, statusOnEnemy: { id: "stun",     duration: 1 } },
  blade_song:          { bonusDamage: 6,  statusOnEnemy: { id: "bleed",    duration: 2 } },
  healing_word:        { bonusDamage: 0,  selfHeal: 18 },
  countercharm:        { bonusDamage: 0,  selfHeal: 10, skipCA: true, reflect: 5 },
  bardic_knowledge:    { bonusDamage: 0,  skipCA: true, enemyDefReduce: 3 },
  inspire:             { bonusDamage: 0,  selfHeal: 5,  reflect: 4 },
  // ── Druid ────────────────────────────────────────────────────────────────────
  natures_wrath:       { bonusDamage: 6,  statusOnEnemy: { id: "poison",   duration: 3 } },
  thorn_whip:          { bonusDamage: 5,  skipCA: true, statusOnEnemy: { id: "bleed",    duration: 2 } },
  regrowth:            { bonusDamage: 0,  selfHeal: 24 },
  wild_form:           { bonusDamage: 0,  selfHeal: 16, skipCA: true },
  commune_nature:      { bonusDamage: 0,  skipCA: true, enemyDefReduce: 3 },
  earthen_tongue:      { bonusDamage: 0,  skipCA: true, enemyDefReduce: 2, statusOnEnemy: { id: "weakened", duration: 3 } },
  // ── Ironclad ─────────────────────────────────────────────────────────────────
  iron_bulwark:        { bonusDamage: 0,  selfHeal: 12, skipCA: true, reflect: 7 },
  armor_crush:         { bonusDamage: 5,  piercing: 6, defenseScaling: 0.6 },
  juggernaut:          { bonusDamage: 2,  selfHeal: 18 },
  pain_tolerance:      { bonusDamage: 0,  selfHeal: 10, skipCA: true },
  combat_sense:        { bonusDamage: 0,  skipCA: true, enemyDefReduce: 4 },
  unyielding:          { bonusDamage: 0,  skipCA: true, statusOnEnemy: { id: "weakened", duration: 2 }, reflect: 5 },
  // ── Hexblade ─────────────────────────────────────────────────────────────────
  cursed_strike:       { bonusDamage: 5,  statusOnEnemy: { id: "bleed",    duration: 4 } },
  hex_bolt:            { bonusDamage: 8,  statusOnEnemy: { id: "decay",    duration: 2 } },
  hex_leech:           { bonusDamage: 4,  drainRatio: 0.7 },
  curse_ward:          { bonusDamage: 0,  selfHeal: 16, skipCA: true },
  eldritch_sight:      { bonusDamage: 0,  skipCA: true, enemyDefReduce: 5, statusOnEnemy: { id: "weakened", duration: 1 } },
  dread_voice:         { bonusDamage: 0,  skipCA: true, statusOnEnemy: { id: "stun",     duration: 1 }, statusOnEnemy2: { id: "weakened", duration: 2 } },
  // ── Drifter ──────────────────────────────────────────────────────────────────
  read_the_room:       { bonusDamage: 0,  skipCA: true, enemyDefReduce: 3 },
  sucker_punch:        { bonusDamage: 7,  skipCA: true, statusOnEnemy: { id: "stun",     duration: 1 } },
  dead_drop:           { bonusDamage: 0,  selfHeal: 10, skipCA: true },
  ghost_step:          { bonusDamage: 0,  selfHeal: 8,  skipCA: true },
  fast_talk:           { bonusDamage: 0,  skipCA: true, statusOnEnemy: { id: "weakened", duration: 3 } },
  reputation_game:     { bonusDamage: 0,  skipCA: true, statusOnEnemy: { id: "weakened", duration: 2 }, reflect: 4 },
  // ── Alchemist ────────────────────────────────────────────────────────────────
  flashbomb:           { bonusDamage: 2,  skipCA: true, statusOnEnemy: { id: "stun",     duration: 2 } },
  acid_splash:         { bonusDamage: 7,  enemyDefReduce: 3, statusOnEnemy: { id: "decay",    duration: 3 } },
  vitalizing_draught:  { bonusDamage: 0,  selfHeal: 20 },
  toxin_ward:          { bonusDamage: 0,  selfHeal: 12, skipCA: true },
  master_brewer:       { bonusDamage: 0,  skipCA: true, enemyDefReduce: 2 },
  merchants_charm:     { bonusDamage: 0,  skipCA: true, statusOnEnemy: { id: "weakened", duration: 3 } },
};

function d6(): number { return Math.floor(Math.random() * 6) + 1; }
function playerDefRating(stats: Stats): number {
  return Math.floor((stats.strength + stats.will) / 5);
}

// d20 DCs: enemy defence/attack divided by 2, base 8
function attackHitDC(enemyDef: number): number { return 8 + Math.floor(enemyDef / 2); }
function blockDC(enemyAtk: number):    number { return 8 + Math.floor(enemyAtk / 2); }

// ─── POST /:id/combat-action ──────────────────────────────────────────────────
router.post("/:id/combat-action", async (req, res) => {
  const sessionId = parseInt(req.params.id);
  if (isNaN(sessionId)) return res.status(400).json({ error: "Invalid session id" });
  if (inFlightSessions.has(sessionId)) return res.status(429).json({ error: "Request already in progress" });
  inFlightSessions.add(sessionId);
  try {
    const { action, skillId, itemId, lang = "en" } = req.body;
    const validActions = ["attack", "defend", "skill", "item", "flee"];
    if (!validActions.includes(action)) return res.status(400).json({ error: "Invalid combat action" });

    const [session] = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
    if (!session) return res.status(404).json({ error: "Session not found" });

    const baseStats   = statsMap.get(sessionId) || DEFAULT_STATS;
    const inventory   = inventoryMap.get(sessionId) ?? [];
    const meta        = playerMetas.get(sessionId);
    let skills        = meta?.skills ?? [];
    const currentEnemy = enemyMap.get(sessionId);
    if (!currentEnemy) return res.status(400).json({ error: "No active combat" });

    let sfx: CombatSfx = statusEffectsMap.get(sessionId) ?? { player: [], enemy: [] };

    let newStats = { ...baseStats };
    let newEnemy = { ...currentEnemy };
    const basePlayerDef = playerDefRating(newStats);

    // Effective enemy stats after debuffs
    let effEnemyAtk = newEnemy.attack;
    let effEnemyDef = newEnemy.defense;
    for (const se of sfx.enemy) { effEnemyAtk = Math.max(0, effEnemyAtk + se.atkMod); effEnemyDef = Math.max(0, effEnemyDef + se.defMod); }

    let playerDamage  = 0;   // damage dealt to enemy
    let damageTaken   = 0;   // damage from enemy counterattack
    let selfDamage    = 0;   // self-inflicted
    let healAmount    = 0;   // HP healed
    let isCritical    = false;
    let isFumble      = false;
    let defended      = false;
    let fled          = false;
    let fleeSuccess   = false;
    let skipCA        = false;
    let statusOnEnemy: StatusEffect | null = null;
    let statusOnPlayer: StatusEffect | null = null;
    const combatLog: string[] = [];
    let usedSkill: Skill | undefined;

    // ── Tick enemy status effects ───────────────────────────────────────────
    const tickedEnemy: StatusEffect[] = [];
    for (const se of sfx.enemy) {
      if (se.damagePerTurn > 0) {
        newEnemy.hp = Math.max(0, newEnemy.hp - se.damagePerTurn);
        combatLog.push(lang === "ko"
          ? `☠ ${se.nameKo}: 적에게 ${se.damagePerTurn} 피해.`
          : `☠ ${se.name}: ${se.damagePerTurn} dmg to enemy.`);
      }
      if (se.maxHpPercent && se.maxHpPercent > 0) {
        const pctDmg = Math.max(1, Math.round(newEnemy.maxHp * se.maxHpPercent / 100));
        newEnemy.hp = Math.max(0, newEnemy.hp - pctDmg);
        combatLog.push(lang === "ko"
          ? `☠ ${se.nameKo}: 최대체력의 ${se.maxHpPercent}% — 적에게 ${pctDmg} 피해.`
          : `☠ ${se.name}: ${se.maxHpPercent}% of max HP — ${pctDmg} dmg to enemy.`);
      }
      if (se.duration - 1 > 0) tickedEnemy.push({ ...se, duration: se.duration - 1 });
    }
    sfx = { ...sfx, enemy: tickedEnemy };

    // ── Resolve player action ────────────────────────────────────────────────
    if (action === "attack") {
      const d20Roll  = rollD20();
      const hitBonus = statModifier(newStats.strength);
      const hitTotal = d20Roll + hitBonus;
      const dc       = attackHitDC(effEnemyDef);
      isCritical     = d20Roll === 20;
      isFumble       = d20Roll === 1;

      if (!isFumble && (isCritical || hitTotal >= dc)) {
        const roll6 = d6();
        let dmg = newStats.strength + roll6 - effEnemyDef;
        if (isCritical) dmg = Math.round(dmg * 1.75);
        playerDamage = Math.max(1, dmg);
      }

      const hitLabel = isFumble
        ? (lang === "ko" ? "대실패!" : "Fumble!")
        : isCritical
          ? (lang === "ko" ? "치명타!" : "Critical hit!")
          : hitTotal >= dc
            ? (lang === "ko" ? "명중!" : "Hit!")
            : (lang === "ko" ? "빗나감!" : "Miss!");

      combatLog.push(lang === "ko"
        ? `⚔ [d20: ${d20Roll}${hitBonus >= 0 ? "+" : ""}${hitBonus}=${hitTotal}] ${hitLabel}${playerDamage > 0 ? ` 적에게 ${playerDamage} 피해.` : ""}`
        : `⚔ [d20: ${d20Roll}${hitBonus >= 0 ? "+" : ""}${hitBonus}=${hitTotal}] ${hitLabel}${playerDamage > 0 ? ` Dealt ${playerDamage} damage.` : ""}`);

    } else if (action === "defend") {
      defended = true;
      skipCA   = true;

      const d20Roll  = rollD20();
      const defBonus = basePlayerDef;
      const defTotal = d20Roll + defBonus;
      const dc       = blockDC(effEnemyAtk);
      const perfect  = d20Roll === 20;
      const blocked  = perfect || defTotal >= dc;

      if (perfect) {
        damageTaken = 0;
        combatLog.push(lang === "ko"
          ? `🛡 [d20: ${d20Roll}+${defBonus}=${defTotal}] 완벽한 방어! 피해 없음.`
          : `🛡 [d20: ${d20Roll}+${defBonus}=${defTotal}] Perfect block! No damage.`);
      } else if (blocked) {
        damageTaken = Math.max(1, effEnemyAtk - basePlayerDef - 4);
        combatLog.push(lang === "ko"
          ? `🛡 [d20: ${d20Roll}+${defBonus}=${defTotal}] 방어 성공! ${damageTaken} 피해 흡수.`
          : `🛡 [d20: ${d20Roll}+${defBonus}=${defTotal}] Blocked! Absorbed, took ${damageTaken} dmg.`);
      } else {
        const roll6 = d6();
        damageTaken = Math.max(1, effEnemyAtk + roll6 - basePlayerDef);
        combatLog.push(lang === "ko"
          ? `🛡 [d20: ${d20Roll}+${defBonus}=${defTotal}] 방어 실패! ${damageTaken} 피해.`
          : `🛡 [d20: ${d20Roll}+${defBonus}=${defTotal}] Block failed! Took ${damageTaken} dmg.`);
      }

    } else if (action === "skill") {
      usedSkill = skills.find(s => s.id === skillId && s.currentCooldown === 0);
      if (!usedSkill) return res.status(400).json({ error: "Skill on cooldown or not found" });

      const fx = COMBAT_SKILL_FX[skillId] ?? { bonusDamage: usedSkill.bonusValue };

      if (fx.bonusDamage > 0 || fx.defenseScaling) {
        const roll6 = d6();
        const piercing = fx.piercing ?? 0;
        let dmg = newStats.strength + roll6 + fx.bonusDamage - Math.max(0, effEnemyDef - piercing);
        if (fx.defenseScaling) {
          const scaledBonus = Math.floor(newEnemy.defense * fx.defenseScaling);
          dmg += scaledBonus;
        }
        playerDamage = Math.max(1, dmg);
      }
      if (fx.drainRatio && playerDamage > 0) healAmount += Math.round(playerDamage * fx.drainRatio);
      if (fx.selfDamage)  selfDamage  += fx.selfDamage;
      if (fx.selfHeal)    healAmount  += fx.selfHeal;
      if (fx.skipCA)      skipCA       = true;

      if (fx.statusOnEnemy) {
        statusOnEnemy = makeStatus(fx.statusOnEnemy.id, fx.statusOnEnemy.duration);
      }

      skills = skills.map(s => s.id === skillId ? { ...s, currentCooldown: s.cooldown } : s);

      // Apply second status effect to enemy (immediately to sfx.enemy so it shows up)
      if (fx.statusOnEnemy2 && newEnemy.hp > 0) {
        const s2 = makeStatus(fx.statusOnEnemy2.id, fx.statusOnEnemy2.duration);
        const idx2 = sfx.enemy.findIndex(se => se.id === s2.id);
        if (idx2 >= 0) sfx.enemy[idx2] = { ...s2 };
        else sfx.enemy = [...sfx.enemy, s2];
      }

      // Permanently reduce enemy defense
      if (fx.enemyDefReduce && newEnemy.hp > 0) {
        newEnemy.defense = Math.max(0, newEnemy.defense - fx.enemyDefReduce);
      }

      const skillLabel = lang === "ko" ? usedSkill.nameKo : usedSkill.name;
      const logParts: string[] = [];
      if (playerDamage > 0) logParts.push(lang === "ko" ? `적에게 ${playerDamage} 피해.` : `Dealt ${playerDamage} dmg.`);
      if (fx.selfDamage)    logParts.push(lang === "ko" ? `자기 피해 ${fx.selfDamage}.` : `Self: -${fx.selfDamage} HP.`);
      if (healAmount > 0)   logParts.push(lang === "ko" ? `HP +${healAmount}.` : `Healed ${healAmount} HP.`);
      if (statusOnEnemy)    logParts.push(lang === "ko" ? `[${statusOnEnemy.nameKo}] 부여.` : `Applied [${statusOnEnemy.name}].`);
      if (fx.statusOnEnemy2 && newEnemy.hp > 0) {
        const s2 = makeStatus(fx.statusOnEnemy2.id, fx.statusOnEnemy2.duration);
        logParts.push(lang === "ko" ? `[${s2.nameKo}] 부여.` : `Applied [${s2.name}].`);
      }
      if (fx.enemyDefReduce && newEnemy.hp > 0) logParts.push(lang === "ko" ? `적 방어력 -${fx.enemyDefReduce}.` : `Enemy DEF -${fx.enemyDefReduce}.`);
      if (fx.reflect)       logParts.push(lang === "ko" ? `반사 준비 ${fx.reflect}.` : `Reflect ${fx.reflect} ready.`);
      if (skipCA)           logParts.push(lang === "ko" ? "반격 회피!" : "Avoids retaliation!");
      combatLog.push(`✨ ${lang === "ko" ? usedSkill.nameKo : usedSkill.name} ${lang === "ko" ? "사용!" : "used!"} ${logParts.join(" ")}`.trim());

    } else if (action === "item") {
      const itemIdx = inventory.findIndex(i => i.id === itemId && i.type === "consumable" && i.quantity > 0);
      if (itemIdx === -1) return res.status(400).json({ error: "Consumable item not found" });
      const item = inventory[itemIdx];

      if (item.effect.hp && item.effect.hp > 0) healAmount += item.effect.hp;
      if (item.effect.damage && item.effect.damage > 0) {
        playerDamage += Math.max(1, item.effect.damage - effEnemyDef);
      }

      const updatedInventory = inventory.map((it, i) =>
        i === itemIdx ? { ...it, quantity: it.quantity - 1 } : it
      ).filter(it => it.quantity > 0);
      inventoryMap.set(sessionId, updatedInventory);

      const itemLabel = lang === "ko" ? item.nameKo : item.name;
      combatLog.push(lang === "ko"
        ? `🎒 ${itemLabel} 사용.${healAmount > 0 ? ` HP +${healAmount}.` : ""}${playerDamage > 0 ? ` 적에게 ${playerDamage} 피해.` : ""}`
        : `🎒 Used ${itemLabel}.${healAmount > 0 ? ` Healed ${healAmount} HP.` : ""}${playerDamage > 0 ? ` Dealt ${playerDamage} dmg.` : ""}`);

    } else if (action === "flee") {
      const fleeRoll = rollD20();
      const fleeBonus = statModifier(newStats.cunning);
      fleeSuccess = (fleeRoll + fleeBonus) >= 11;
      fled = fleeSuccess;
      skipCA = true;
      if (fleeSuccess) {
        combatLog.push(lang === "ko" ? "💨 성공적으로 도망쳤습니다!" : "💨 Fled from combat!");
      } else {
        const roll6 = d6();
        damageTaken = Math.max(1, effEnemyAtk + roll6 - basePlayerDef);
        combatLog.push(lang === "ko"
          ? `💨 도주 실패! 적의 반격으로 ${damageTaken} 피해.`
          : `💨 Failed to flee! Enemy counterattacked for ${damageTaken} dmg.`);
      }
    }

    // ── Apply player damage to enemy ────────────────────────────────────────
    if (playerDamage > 0) {
      newEnemy.hp = Math.max(0, newEnemy.hp - playerDamage);
    }

    // ── Apply new enemy status effect ───────────────────────────────────────
    if (statusOnEnemy && newEnemy.hp > 0) {
      const existingIdx = sfx.enemy.findIndex(se => se.id === statusOnEnemy!.id);
      if (existingIdx >= 0) {
        sfx.enemy[existingIdx] = { ...statusOnEnemy };
      } else {
        sfx.enemy = [...sfx.enemy, statusOnEnemy];
      }
    }
    // Attach current status effects to enemy object for client
    newEnemy = { ...newEnemy, statusEffects: sfx.enemy };

    // ── Enemy counterattack ─────────────────────────────────────────────────
    const enemyStunned = sfx.enemy.some(se => se.id === "stun");
    if (!skipCA && !fled && newEnemy.hp > 0) {
      if (enemyStunned) {
        combatLog.push(lang === "ko" ? "😵 적이 기절! 반격 불가." : "😵 Enemy stunned — no counterattack!");
      } else {
        const roll6 = d6();
        const caDmg = Math.max(1, effEnemyAtk + roll6 - basePlayerDef);
        const invertDmg = usedSkill ? (COMBAT_SKILL_FX[usedSkill.id]?.invertDamage ?? false) : false;
        if (invertDmg) {
          // ── Invert: enemy attack heals you instead of dealing damage ──
          healAmount += caDmg;
          combatLog.push(lang === "ko"
            ? `🦴 뼈 결계가 적의 ${caDmg} 공격을 흡수해 HP +${caDmg} 회복!`
            : `🦴 Bone ward absorbs the ${caDmg} attack — healed ${caDmg} HP instead!`);
        } else {
          damageTaken += caDmg;
          combatLog.push(lang === "ko"
            ? `💥 적의 반격: ${caDmg} 피해.`
            : `💥 Enemy counterattacked: ${caDmg} dmg.`);
          // ── Reflect: bounce damage back to enemy ────────────────────
          const reflectAmt = usedSkill ? (COMBAT_SKILL_FX[usedSkill.id]?.reflect ?? 0) : 0;
          if (reflectAmt > 0 && newEnemy.hp > 0) {
            const reflected = Math.min(caDmg, reflectAmt);
            newEnemy.hp = Math.max(0, newEnemy.hp - reflected);
            combatLog.push(lang === "ko"
              ? `🔄 ${reflected} 피해 반사!`
              : `🔄 Reflected ${reflected} damage back!`);
          }
        }
      }
    }

    // ── Reflect aura (skipCA skills): aura damage even when enemy can't attack ─
    if (usedSkill && skipCA && !fled && newEnemy.hp > 0) {
      const auraReflect = COMBAT_SKILL_FX[usedSkill.id]?.reflect ?? 0;
      if (auraReflect > 0) {
        newEnemy.hp = Math.max(0, newEnemy.hp - auraReflect);
        combatLog.push(lang === "ko"
          ? `🔄 방어 기운이 적에게 ${auraReflect} 피해!`
          : `🔄 Defensive aura deals ${auraReflect} damage!`);
      }
    }

    // ── Tick player status effects ──────────────────────────────────────────
    const tickedPlayer: StatusEffect[] = [];
    for (const se of sfx.player) {
      if (se.damagePerTurn > 0) {
        damageTaken += se.damagePerTurn;
        combatLog.push(lang === "ko"
          ? `☠ ${se.nameKo}: ${se.damagePerTurn} 피해.`
          : `☠ ${se.name}: ${se.damagePerTurn} dmg.`);
      }
      if (se.duration - 1 > 0) tickedPlayer.push({ ...se, duration: se.duration - 1 });
    }
    if (statusOnPlayer) {
      const pIdx = tickedPlayer.findIndex(s => s.id === statusOnPlayer!.id);
      if (pIdx >= 0) tickedPlayer[pIdx] = { ...statusOnPlayer };
      else tickedPlayer.push(statusOnPlayer);
    }
    sfx = { ...sfx, player: tickedPlayer };

    // ── Apply HP changes ────────────────────────────────────────────────────
    const totalHpDelta = healAmount - damageTaken - selfDamage;
    newStats = applyStatChanges(newStats, { hp: totalHpDelta });

    // ── Determine outcome ───────────────────────────────────────────────────
    const playerDied   = newStats.hp <= 0;
    const enemyDied    = newEnemy.hp <= 0;
    const combatEnded  = playerDied || enemyDied || fled;
    const inCombat     = !combatEnded;

    // ── Update maps ─────────────────────────────────────────────────────────
    statsMap.set(sessionId, newStats);
    enemyMap.set(sessionId, inCombat ? newEnemy : null);
    statusEffectsMap.set(sessionId, inCombat ? sfx : { player: [], enemy: [] });
    skills = tickSkillCooldowns(skills);
    if (meta) playerMetas.set(sessionId, { ...meta, skills });

    // ── Build AI narration ──────────────────────────────────────────────────
    const entries = await db.select().from(storyEntries).where(eq(storyEntries.sessionId, sessionId));

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: lang === "ko" ? SYSTEM_PROMPT_KO : SYSTEM_PROMPT_EN },
    ];
    for (const entry of entries) {
      if (entry.entryType === "narration") {
        messages.push({ role: "assistant", content: entry.content });
      } else if (entry.entryType === "choice") {
        const cd = JSON.parse(entry.content);
        messages.push({ role: "user", content: cd.context ?? cd.text });
      }
    }

    const worldMemoryCombat = buildWorldMemoryBlock(sessionId, lang);
    const combatSummary = lang === "ko"
      ? `[전투 행동: ${action}] ${combatLog.join(" ")} 플레이어 HP: ${newStats.hp}/${newStats.maxHp}. 적 HP: ${newEnemy.hp}/${newEnemy.maxHp}.${enemyDied ? " 적이 쓰러졌다!" : ""}${playerDied ? " 플레이어 사망!" : ""}${fled ? " 전투 이탈." : ""}${worldMemoryCombat}`
      : `[Combat action: ${action}] ${combatLog.join(" ")} Player HP: ${newStats.hp}/${newStats.maxHp}. Enemy HP: ${newEnemy.hp}/${newEnemy.maxHp}.${enemyDied ? " Enemy defeated!" : ""}${playerDied ? " Player died!" : ""}${fled ? " Fled combat." : ""}${worldMemoryCombat}`;

    let aiData: Record<string, any>;

    if (enemyDied && !playerDied) {
      // Enemy defeated — single AI call for victory continuation (saves one round-trip)
      const victoryMsg = lang === "ko"
        ? `[전투 종료: 적 처치] ${combatLog.join(" ")} ${newEnemy.name}이(가) 쓰러졌습니다. 전투 결과를 짧게 묘사하고 다음 장면과 3가지 선택지를 제시하세요. inCombat: false, enemy: null.${worldMemoryCombat}`
        : `[Combat over: enemy defeated] ${combatLog.join(" ")} ${newEnemy.name} has fallen. Briefly narrate the kill and continue with the next scene. Provide 3 choices. inCombat: false, enemy: null.${worldMemoryCombat}`;
      messages.push({ role: "user", content: victoryMsg });
      const vc = await openai.chat.completions.create({
        model: "gpt-4o", messages,
        response_format: { type: "json_object" }, temperature: 0.95,
      });
      const vd = JSON.parse(vc.choices[0].message.content ?? "{}");
      aiData = { ...vd, inCombat: false, enemy: null, enemyChanges: { hp: -playerDamage }, choices: vd.choices ?? [], itemsGained: vd.itemsGained ?? [] };

      if (Array.isArray(vd.itemsGained) && vd.itemsGained.length > 0) {
        const mergedInv = mergeItems(inventoryMap.get(sessionId) ?? [], vd.itemsGained);
        inventoryMap.set(sessionId, mergedInv);
      }
    } else if (fled && fleeSuccess) {
      // Successful flee — single AI call for escape continuation
      const fleeMsg = lang === "ko"
        ? `[전투 이탈 성공] ${combatLog.join(" ")} 플레이어가 성공적으로 도망쳤습니다. 도주 장면을 묘사하고 다음 장면과 3가지 선택지를 제시하세요. inCombat: false.${worldMemoryCombat}`
        : `[Combat fled successfully] ${combatLog.join(" ")} Player escaped. Narrate the escape and continue with the next scene. Provide 3 choices. inCombat: false.${worldMemoryCombat}`;
      messages.push({ role: "user", content: fleeMsg });
      const fc = await openai.chat.completions.create({
        model: "gpt-4o", messages,
        response_format: { type: "json_object" }, temperature: 0.95,
      });
      const fd = JSON.parse(fc.choices[0].message.content ?? "{}");
      aiData = { ...fd, inCombat: false, enemy: null, enemyChanges: { hp: 0 }, choices: fd.choices ?? [] };
    } else {
      // Combat continues or player died — single AI call for narration
      messages.push({ role: "user", content: combatSummary });
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages,
        response_format: { type: "json_object" },
        temperature: 0.9,
      });
      aiData = JSON.parse(completion.choices[0].message.content ?? "{}");
      aiData.choices = playerDied ? [] : [];  // no story choices during combat or on death
      aiData.inCombat    = inCombat;
      aiData.enemy       = inCombat ? newEnemy : null;
      aiData.enemyChanges = { hp: -playerDamage };
    }

    // Always authoritative server overrides
    aiData.isEnding     = playerDied || (!!aiData.isEnding && !!aiData.goalAchieved);
    aiData.goalAchieved = !playerDied && !!aiData.goalAchieved;
    aiData.statChanges  = totalHpDelta !== 0 ? { hp: totalHpDelta } : {};

    // ── Persist ─────────────────────────────────────────────────────────────
    const actionLabel = lang === "ko"
      ? ({ attack: "공격", defend: "방어", skill: usedSkill?.nameKo ?? "스킬", item: "아이템", flee: "도주" }[action])
      : ({ attack: "Attack", defend: "Defend", skill: usedSkill?.name ?? "Skill", item: "Item", flee: "Flee" }[action]);

    const combatStateSnapshot = {
      stats:        newStats,
      inventory:    inventoryMap.get(sessionId) ?? [],
      meta:         playerMetas.get(sessionId),
      worldEvents:  worldEventsMap.get(sessionId) ?? [],
      enemy:        inCombat ? newEnemy : null,
      statusEffects: statusEffectsMap.get(sessionId) ?? null,
    };
    await db.insert(storyEntries).values([
      { sessionId, entryType: "choice", content: JSON.stringify({ text: `[Combat: ${actionLabel}]`, context: combatSummary }) },
      { sessionId, entryType: "narration", content: JSON.stringify({ ...aiData, _state: combatStateSnapshot }), choiceIndex: -1 },
    ]);
    await db.update(gameSessions)
      .set({ turnCount: session.turnCount + 1, updatedAt: new Date() })
      .where(eq(gameSessions.id, sessionId));

    const finalInventory = inventoryMap.get(sessionId) ?? [];
    const effectiveStats = applyEquipmentBonuses(newStats, finalInventory);

    const combatResult = {
      playerDamage,
      damageTaken,
      selfDamage,
      healAmount,
      isCritical,
      isFumble,
      defended,
      fled,
      fleeSuccess,
      enemyStunned,
      statusOnEnemy,
      statusOnPlayer,
      combatLog,
    };

    // Accumulate world events from victory/flee narration
    if (Array.isArray(aiData.worldEvents) && aiData.worldEvents.length > 0) {
      addWorldEvents(sessionId, aiData.worldEvents.filter((e: unknown) => typeof e === "string"), session.turnCount + 1);
    }

    res.json({
      ...aiData,
      stats: effectiveStats,
      skills,
      enemy: inCombat ? newEnemy : null,
      inCombat,
      inventory: finalInventory,
      itemsGained: aiData.itemsGained ?? [],
      combatResult,
      worldEvents: worldEventsMap.get(sessionId) ?? [],
    });
  } catch (err) {
    req.log.error(err, "Error processing combat action");
    res.status(500).json({ error: "Failed to process combat action" });
  } finally {
    inFlightSessions.delete(sessionId);
  }
});

export default router;


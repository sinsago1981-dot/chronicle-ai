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

type Enemy = { name: string; hp: number; maxHp: number; attack: number; defense: number };

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
    { id: "battle_cry",         skillType: "combat",   name: "Battle Cry",          nameKo: "전투의 함성",     description: "A fearsome war cry that channels your battle fury into raw power.",                      descriptionKo: "두려움을 불러일으키는 함성으로 전투 분노를 원초적 힘으로 전환한다.",     statBonus: "strength",   bonusValue: 3,              cooldown: 3, currentCooldown: 0 },
    { id: "berserker_rage",     skillType: "combat",   name: "Berserker Rage",      nameKo: "광전사의 분노",   description: "Abandon all defense and unleash devastating strikes. Pain fuels your rage.",                descriptionKo: "모든 방어를 포기하고 파괴적인 일격을 가한다. 고통이 분노를 부채질한다.", statBonus: "strength",   bonusValue: 5, hpEffect: -8, cooldown: 3, currentCooldown: 0, statRequirement: { stat: "strength",   min: 7 } },
    { id: "iron_skin",          skillType: "survival", name: "Iron Skin",           nameKo: "강철 피부",       description: "Harden your body against punishment. You endure what would break others.",                 descriptionKo: "몸을 단련해 징벌을 견뎌낸다. 남들이 부서지는 것을 버텨낸다.",           statBonus: "strength",   bonusValue: 1, hpEffect: 15, cooldown: 3, currentCooldown: 0 },
    { id: "last_stand",         skillType: "survival", name: "Last Stand",          nameKo: "최후의 저항",     description: "Near death, your will to survive surges. Wounds close. Resolve hardens.",                  descriptionKo: "죽음 직전, 생존 의지가 치솟는다. 상처가 닫히고 의지가 굳어진다.",       statBonus: "will",       bonusValue: 2, hpEffect: 20, cooldown: 4, currentCooldown: 0, statRequirement: { stat: "will",       min: 7 } },
    { id: "soldier_instinct",   skillType: "utility",  name: "Soldier's Instinct",  nameKo: "병사의 본능",     description: "Battlefield experience sharpens your read of any situation. Danger never catches you off guard.", descriptionKo: "전장 경험이 모든 상황을 읽는 감각을 날카롭게 한다. 위험이 당신을 빈틈에 잡지 못한다.", statBonus: "cunning", bonusValue: 3, cooldown: 2, currentCooldown: 0 },
    { id: "warlord_presence",   skillType: "social",   name: "Warlord's Presence",  nameKo: "군주의 존재감",   description: "Your reputation as a warrior precedes you. Enemies hesitate. Allies rally.",                 descriptionKo: "전사로서의 명성이 먼저 도착한다. 적은 망설이고 아군은 집결한다.",        statBonus: "reputation", bonusValue: 4,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "reputation", min: 5 } },
  ],
  Rogue: [
    { id: "shadow_strike",      skillType: "combat",   name: "Shadow Strike",       nameKo: "그림자 일격",     description: "Melt into shadow and strike from an unseen angle.",                                        descriptionKo: "그림자 속으로 사라져 보이지 않는 각도에서 공격한다.",                     statBonus: "cunning",    bonusValue: 4,              cooldown: 3, currentCooldown: 0 },
    { id: "smoke_bomb",         skillType: "combat",   name: "Smoke Bomb",          nameKo: "연막탄",          description: "Throw a smoke bomb to vanish, reposition, and gain a critical edge.",                      descriptionKo: "연막탄을 던져 사라지고, 위치를 바꾸고, 결정적 우위를 점한다.",            statBonus: "cunning",    bonusValue: 3,              cooldown: 2, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 6 } },
    { id: "vanish",             skillType: "survival", name: "Vanish",              nameKo: "잠적",            description: "Disappear completely. No one finds you unless you wish to be found.",                      descriptionKo: "완전히 사라진다. 원하지 않는 한 아무도 당신을 찾지 못한다.",              statBonus: "cunning",    bonusValue: 2, hpEffect: 8,  cooldown: 3, currentCooldown: 0 },
    { id: "street_tough",       skillType: "survival", name: "Street Tough",        nameKo: "길거리 강인함",   description: "A lifetime of hard knocks left you wiry and resilient. You take hits others can't.",         descriptionKo: "거친 삶이 강인함을 남겼다. 남들이 못 버티는 타격을 버텨낸다.",            statBonus: "strength",   bonusValue: 2, hpEffect: 12, cooldown: 3, currentCooldown: 0, statRequirement: { stat: "strength",   min: 6 } },
    { id: "lockpick",           skillType: "utility",  name: "Lockpick",            nameKo: "자물쇠 따기",     description: "No lock, no vault, no sealed door stands between you and what's inside.",                   descriptionKo: "어떤 자물쇠도, 금고도, 잠긴 문도 당신과 안쪽 사이에 없다.",              statBonus: "cunning",    bonusValue: 3,              cooldown: 2, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 7 } },
    { id: "silver_tongue",      skillType: "social",   name: "Silver Tongue",       nameKo: "은빛 혀",         description: "Half-truths, full charm. You talk your way in or out of anything.",                         descriptionKo: "반쪽 진실, 완전한 매력. 어떤 상황이든 말로 헤쳐나간다.",                  statBonus: "reputation", bonusValue: 3,              cooldown: 3, currentCooldown: 0 },
  ],
  Mage: [
    { id: "arcane_surge",       skillType: "combat",   name: "Arcane Surge",        nameKo: "비전 쇄도",       description: "Channel raw magical energy to amplify the power of your next spell.",                      descriptionKo: "원초적 마법 에너지를 모아 다음 주문의 위력을 증폭시킨다.",               statBonus: "will",       bonusValue: 4,              cooldown: 3, currentCooldown: 0 },
    { id: "chain_lightning",    skillType: "combat",   name: "Chain Lightning",     nameKo: "연쇄 번개",       description: "Electricity arcs from target to target, punishing clusters of enemies.",                   descriptionKo: "전기가 대상에서 대상으로 튀며 무리 지은 적들을 벌한다.",                  statBonus: "will",       bonusValue: 5,              cooldown: 4, currentCooldown: 0, statRequirement: { stat: "will",       min: 8 } },
    { id: "mana_shield",        skillType: "survival", name: "Mana Shield",         nameKo: "마나 방어막",     description: "Wrap yourself in arcane energy. It hurts — but it protects.",                              descriptionKo: "비전 에너지로 자신을 감싼다. 아프지만 보호해준다.",                       statBonus: "will",       bonusValue: 2, hpEffect: 10, cooldown: 3, currentCooldown: 0 },
    { id: "spell_recovery",     skillType: "survival", name: "Spell Recovery",      nameKo: "주문 회복",       description: "Redirect spell energy inward to mend your body and restore focus.",                         descriptionKo: "주문 에너지를 내부로 돌려 몸을 회복하고 집중력을 되찾는다.",               statBonus: "will",       bonusValue: 1, hpEffect: 18, cooldown: 4, currentCooldown: 0, statRequirement: { stat: "will",       min: 9 } },
    { id: "arcane_sight",       skillType: "utility",  name: "Arcane Sight",        nameKo: "마법 시야",       description: "Perceive magic, intent, and hidden structure others cannot see.",                            descriptionKo: "남들이 볼 수 없는 마법, 의도, 숨겨진 구조를 인식한다.",                    statBonus: "cunning",    bonusValue: 3,              cooldown: 2, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 6 } },
    { id: "enchanting_words",   skillType: "social",   name: "Enchanting Words",    nameKo: "마혹의 말",       description: "Weave subtle compulsion into conversation. Minds bend without knowing why.",                 descriptionKo: "대화에 은밀한 강요를 엮는다. 마음이 이유도 모르고 굽어진다.",              statBonus: "reputation", bonusValue: 4,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "reputation", min: 6 } },
  ],
  Paladin: [
    { id: "holy_strike",        skillType: "combat",   name: "Holy Strike",         nameKo: "성스러운 일격",   description: "Channel divine light through your weapon for a consecrated blow.",                         descriptionKo: "무기를 통해 신성한 빛을 흘려보내 성결된 일격을 가한다.",                 statBonus: "will",       bonusValue: 4,              cooldown: 3, currentCooldown: 0 },
    { id: "divine_smite",       skillType: "combat",   name: "Divine Smite",        nameKo: "신성한 강타",     description: "Pour divine wrath into a single devastating blow. Darkness recoils.",                      descriptionKo: "신성한 분노를 단 한 번의 파괴적인 일격에 쏟아붓는다. 어둠이 물러선다.",  statBonus: "will",       bonusValue: 6,              cooldown: 4, currentCooldown: 0, statRequirement: { stat: "will",       min: 8 } },
    { id: "lay_on_hands",       skillType: "survival", name: "Lay on Hands",        nameKo: "안수",            description: "Channel holy energy to heal your wounds through sheer faith.",                            descriptionKo: "순수한 신앙으로 성스러운 에너지를 모아 상처를 치유한다.",                 statBonus: "will",       bonusValue: 1, hpEffect: 22, cooldown: 4, currentCooldown: 0 },
    { id: "divine_protection",  skillType: "survival", name: "Divine Protection",   nameKo: "신성한 보호",     description: "A holy ward absorbs the worst of what comes. You stand where others fall.",                 descriptionKo: "신성한 결계가 최악을 흡수한다. 남들이 쓰러지는 곳에서 당신은 서 있다.",  statBonus: "will",       bonusValue: 2, hpEffect: 15, cooldown: 3, currentCooldown: 0, statRequirement: { stat: "will",       min: 9 } },
    { id: "judgement",          skillType: "utility",  name: "Judgement",           nameKo: "심판",            description: "Your divine authority strips away deception. Truth is laid bare.",                          descriptionKo: "신성한 권위로 기만을 벗겨낸다. 진실이 드러난다.",                         statBonus: "cunning",    bonusValue: 3,              cooldown: 2, currentCooldown: 0, statRequirement: { stat: "strength",   min: 7 } },
    { id: "blessed_presence",   skillType: "social",   name: "Blessed Presence",    nameKo: "축복받은 존재",   description: "Your faith radiates outward. Those around you feel its pull, whether they want to or not.", descriptionKo: "신앙이 외부로 발산된다. 원하든 원하지 않든 주위 사람들이 그 당김을 느낀다.", statBonus: "reputation", bonusValue: 4, cooldown: 3, currentCooldown: 0 },
  ],
  Ranger: [
    { id: "precision_shot",     skillType: "combat",   name: "Precision Shot",      nameKo: "정밀 사격",       description: "Take careful aim, reading the wind, the distance, and your prey.",                         descriptionKo: "바람과 거리, 그리고 먹잇감을 읽으며 신중하게 조준한다.",                  statBonus: "cunning",    bonusValue: 4,              cooldown: 3, currentCooldown: 0 },
    { id: "volley",             skillType: "combat",   name: "Volley",              nameKo: "일제 사격",       description: "Loose a rapid burst of arrows that blankets the area. No one escapes clean.",              descriptionKo: "신속한 화살 연사로 지역을 덮친다. 누구도 깨끗이 빠져나가지 못한다.",    statBonus: "cunning",    bonusValue: 3,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 6 } },
    { id: "beast_bond",         skillType: "survival", name: "Beast Bond",          nameKo: "야수의 유대",     description: "Attune with the wild — your instincts sharpen to an animal edge.",                         descriptionKo: "야생과 교감한다 — 본능이 동물적 예리함으로 날카로워진다.",              statBonus: "cunning",    bonusValue: 3,              cooldown: 2, currentCooldown: 0 },
    { id: "camouflage",         skillType: "survival", name: "Camouflage",          nameKo: "위장",            description: "Become one with the terrain. You vanish before they even know you're there.",             descriptionKo: "지형과 하나가 된다. 그들이 당신의 존재를 알기도 전에 사라진다.",          statBonus: "cunning",    bonusValue: 2, hpEffect: 8,  cooldown: 3, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 7 } },
    { id: "trackmaster",        skillType: "utility",  name: "Trackmaster",         nameKo: "추적 전문가",     description: "Every path, every disturbance, every sign in the wild speaks to you.",                      descriptionKo: "모든 길, 모든 흔적, 야생의 모든 신호가 당신에게 말을 건다.",              statBonus: "cunning",    bonusValue: 3,              cooldown: 2, currentCooldown: 0 },
    { id: "hunters_mark",       skillType: "social",   name: "Hunter's Mark",       nameKo: "사냥꾼의 낙인",   description: "Mark a target. Everyone knows. Your prey feels eyes wherever they run.",                   descriptionKo: "대상을 낙인찍는다. 모두가 안다. 어디로 도망치든 눈이 느껴진다.",         statBonus: "reputation", bonusValue: 3,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "reputation", min: 6 } },
  ],
  Necromancer: [
    { id: "soul_drain",         skillType: "combat",   name: "Soul Drain",          nameKo: "영혼 흡수",       description: "Siphon life force from your target, healing yourself as you drain them.",                  descriptionKo: "대상에서 생명력을 빨아들여 흡수하면서 자신을 치유한다.",                  statBonus: "will",       bonusValue: 3, hpEffect: 15, cooldown: 4, currentCooldown: 0 },
    { id: "deaths_embrace",     skillType: "combat",   name: "Death's Embrace",     nameKo: "죽음의 포옹",     description: "Embrace death's power directly — reality bends at your command.",                         descriptionKo: "죽음의 힘을 직접 받아들인다 — 현실이 당신의 명령에 굴복한다.",          statBonus: "will",       bonusValue: 5,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "will",       min: 7 } },
    { id: "bone_ward",          skillType: "survival", name: "Bone Ward",           nameKo: "뼈 결계",         description: "Raise fragments of the dead as a shield. Their bones take the blow.",                     descriptionKo: "죽은 자의 파편을 방패로 세운다. 그들의 뼈가 타격을 받아낸다.",            statBonus: "will",       bonusValue: 1, hpEffect: 12, cooldown: 3, currentCooldown: 0 },
    { id: "undying",            skillType: "survival", name: "Undying",             nameKo: "불사",            description: "Death has tried before. Your body refuses. You rise when others stay down.",              descriptionKo: "죽음이 전에도 시도했다. 당신의 몸은 거부한다. 남들이 쓰러질 때 일어선다.", statBonus: "will",       bonusValue: 2, hpEffect: 22, cooldown: 5, currentCooldown: 0, statRequirement: { stat: "will",       min: 8 } },
    { id: "dark_ritual",        skillType: "utility",  name: "Dark Ritual",         nameKo: "어둠의 의식",     description: "Perform forbidden rites that unlock truths others dare not seek.",                         descriptionKo: "다른 이들이 감히 찾지 못하는 진실을 여는 금기 의식을 행한다.",            statBonus: "cunning",    bonusValue: 4,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 6 } },
    { id: "terrifying_visage",  skillType: "social",   name: "Terrifying Visage",   nameKo: "공포의 외양",     description: "Your presence breaks will. Enemies flee or freeze before you speak.",                      descriptionKo: "당신의 존재가 의지를 꺾는다. 말하기도 전에 적들이 도망치거나 굳어진다.",  statBonus: "reputation", bonusValue: 4,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "reputation", min: 5 } },
  ],
  Bard: [
    { id: "dissonant_whisper",  skillType: "combat",   name: "Dissonant Whisper",   nameKo: "불협화음",        description: "A haunting melody that rattles minds and makes your reputation precede you.",             descriptionKo: "마음을 흔드는 선율과 함께 당신의 명성이 앞서 울린다.",                   statBonus: "reputation", bonusValue: 4,              cooldown: 3, currentCooldown: 0 },
    { id: "blade_song",         skillType: "combat",   name: "Blade Song",          nameKo: "칼날 노래",       description: "Music and steel become one. Every note lands with an edge.",                             descriptionKo: "음악과 강철이 하나가 된다. 모든 음표가 날이 서 있다.",                    statBonus: "strength",   bonusValue: 3,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "strength",   min: 5 } },
    { id: "healing_word",       skillType: "survival", name: "Healing Word",        nameKo: "치유의 말",       description: "Speak words of power that mend flesh and soothe pain.",                                  descriptionKo: "살을 치유하고 고통을 달래는 힘의 말을 전한다.",                           statBonus: "reputation", bonusValue: 1, hpEffect: 18, cooldown: 3, currentCooldown: 0 },
    { id: "countercharm",       skillType: "survival", name: "Countercharm",        nameKo: "반격 매력",       description: "Your performance neutralises fear, charm, and compulsion in those who hear.",             descriptionKo: "당신의 연주가 듣는 이들의 공포, 매혹, 강요를 무력화한다.",                statBonus: "will",       bonusValue: 2, hpEffect: 10, cooldown: 3, currentCooldown: 0, statRequirement: { stat: "will",       min: 6 } },
    { id: "bardic_knowledge",   skillType: "utility",  name: "Bardic Knowledge",    nameKo: "음유시인의 지식", description: "Your travels filled your head with lore. There's almost nothing you don't know a little about.", descriptionKo: "여행이 머릿속을 지식으로 가득 채웠다. 조금이라도 모르는 것이 거의 없다.", statBonus: "cunning",    bonusValue: 4,              cooldown: 2, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 7 } },
    { id: "inspire",            skillType: "social",   name: "Inspire",             nameKo: "고무",            description: "Your words lift spirits and turn hesitation into resolve.",                               descriptionKo: "당신의 말이 사기를 높이고 망설임을 결의로 바꾼다.",                        statBonus: "reputation", bonusValue: 5,              cooldown: 4, currentCooldown: 0, statRequirement: { stat: "reputation", min: 6 } },
  ],
  Druid: [
    { id: "natures_wrath",      skillType: "combat",   name: "Nature's Wrath",      nameKo: "자연의 분노",     description: "Unleash the primal fury of the wild upon your enemies.",                                  descriptionKo: "야생의 원초적 분노를 적들에게 해방시킨다.",                               statBonus: "will",       bonusValue: 4,              cooldown: 3, currentCooldown: 0 },
    { id: "thorn_whip",         skillType: "combat",   name: "Thorn Whip",          nameKo: "가시 채찍",       description: "Living thorns tear into flesh and drag enemies into your reach.",                         descriptionKo: "살아있는 가시가 살을 찢고 적들을 당신의 손닿는 곳으로 끌어당긴다.",      statBonus: "strength",   bonusValue: 3,              cooldown: 2, currentCooldown: 0, statRequirement: { stat: "strength",   min: 5 } },
    { id: "regrowth",           skillType: "survival", name: "Regrowth",            nameKo: "재생",            description: "Channel natural life force to rapidly regenerate your body.",                             descriptionKo: "자연의 생명력을 모아 몸을 빠르게 재생시킨다.",                            statBonus: "will",       bonusValue: 1, hpEffect: 24, cooldown: 4, currentCooldown: 0 },
    { id: "wild_form",          skillType: "survival", name: "Wild Form",           nameKo: "야생 형상",       description: "Shift briefly into a beast. Injuries fade. Instincts take over.",                        descriptionKo: "잠시 야수로 변신한다. 부상이 사라진다. 본능이 지배한다.",                  statBonus: "will",       bonusValue: 2, hpEffect: 16, cooldown: 4, currentCooldown: 0, statRequirement: { stat: "will",       min: 8 } },
    { id: "commune_nature",     skillType: "utility",  name: "Commune with Nature", nameKo: "자연과 교감",     description: "The living world speaks. You listen. Hidden paths, hidden dangers — all revealed.",         descriptionKo: "살아있는 세계가 말한다. 당신이 듣는다. 숨겨진 길, 숨겨진 위험 — 모두 드러난다.", statBonus: "cunning",  bonusValue: 3, cooldown: 2, currentCooldown: 0 },
    { id: "earthen_tongue",     skillType: "social",   name: "Earthen Tongue",      nameKo: "대지의 언어",     description: "Speak with authority drawn from the land itself. Nature lends your words weight.",         descriptionKo: "대지 자체에서 끌어낸 권위로 말한다. 자연이 당신의 말에 무게를 더한다.",  statBonus: "reputation", bonusValue: 4,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "reputation", min: 6 } },
  ],
  Ironclad: [
    { id: "iron_bulwark",       skillType: "combat",   name: "Iron Bulwark",        nameKo: "철벽",            description: "Become an immovable wall. Absorb the blow and retaliate with measured force.",            descriptionKo: "움직이지 않는 방벽이 된다. 충격을 흡수하고 절제된 힘으로 반격한다.",    statBonus: "strength",   bonusValue: 3, hpEffect: 12, cooldown: 3, currentCooldown: 0 },
    { id: "armor_crush",        skillType: "combat",   name: "Armor Crush",         nameKo: "갑옷 분쇄",       description: "A crushing blow that exploits gaps in any defense, however strong.",                      descriptionKo: "어떤 방어구의 틈새든 파고드는 분쇄 일격.",                               statBonus: "strength",   bonusValue: 5,              cooldown: 4, currentCooldown: 0, statRequirement: { stat: "strength",   min: 7 } },
    { id: "juggernaut",         skillType: "survival", name: "Juggernaut",          nameKo: "저거넛",          description: "Nothing stops your advance. Endurance beyond human limits.",                             descriptionKo: "아무것도 당신의 전진을 막지 못한다. 인간의 한계를 넘는 지구력.",          statBonus: "strength",   bonusValue: 2, hpEffect: 18, cooldown: 4, currentCooldown: 0, statRequirement: { stat: "strength",   min: 8 } },
    { id: "pain_tolerance",     skillType: "survival", name: "Pain Tolerance",      nameKo: "고통 내성",       description: "You've been hit harder. Pain is information. You use it and move on.",                    descriptionKo: "더 심하게 맞은 적이 있다. 고통은 정보다. 이용하고 계속 나아간다.",       statBonus: "strength",   bonusValue: 1, hpEffect: 10, cooldown: 2, currentCooldown: 0 },
    { id: "combat_sense",       skillType: "utility",  name: "Combat Sense",        nameKo: "전투 감각",       description: "Your battlefield awareness compensates for raw cunning. Angles unseen, openings found.",   descriptionKo: "전장 인식이 교활함을 보완한다. 보이지 않는 각도, 발견된 빈틈.",           statBonus: "cunning",    bonusValue: 3,              cooldown: 2, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 4 } },
    { id: "unyielding",         skillType: "social",   name: "Unyielding Stance",   nameKo: "굽히지 않는 자세",description: "You don't negotiate. You don't flinch. That alone changes what people ask of you.",         descriptionKo: "협상하지 않는다. 움찔하지 않는다. 그것만으로 사람들이 당신에게 요구하는 것이 바뀐다.", statBonus: "reputation", bonusValue: 3, cooldown: 3, currentCooldown: 0 },
  ],
  Hexblade: [
    { id: "cursed_strike",      skillType: "combat",   name: "Cursed Strike",       nameKo: "저주 일격",       description: "The curse flows into your weapon. What you cut does not heal cleanly.",                   descriptionKo: "저주가 무기로 흘러든다. 베인 상처는 깨끗이 낫지 않는다.",               statBonus: "will",       bonusValue: 4,              cooldown: 3, currentCooldown: 0 },
    { id: "hex_bolt",           skillType: "combat",   name: "Hex Bolt",            nameKo: "저주 볼트",       description: "Launch raw curse energy as a bolt. Distance means nothing to the hex.",                  descriptionKo: "원초적 저주 에너지를 볼트로 발사한다. 저주에게 거리는 의미 없다.",        statBonus: "will",       bonusValue: 5,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "will",       min: 7 } },
    { id: "hex_leech",          skillType: "survival", name: "Hex Leech",           nameKo: "저주 흡혈",       description: "Channel the curse outward. Their suffering sustains you.",                                 descriptionKo: "저주를 밖으로 흘려보낸다. 그들의 고통이 당신을 지탱한다.",               statBonus: "will",       bonusValue: 3, hpEffect: 14, cooldown: 4, currentCooldown: 0 },
    { id: "curse_ward",         skillType: "survival", name: "Curse Ward",          nameKo: "저주 결계",       description: "Turn the curse upon itself. What tried to harm you becomes your armor.",                   descriptionKo: "저주를 자기 자신에게 향하게 한다. 당신을 해치려 했던 것이 갑옷이 된다.", statBonus: "will",       bonusValue: 2, hpEffect: 16, cooldown: 4, currentCooldown: 0, statRequirement: { stat: "will",       min: 8 } },
    { id: "eldritch_sight",     skillType: "utility",  name: "Eldritch Sight",      nameKo: "이계의 시야",     description: "Peer through the veil. Hidden things become apparent. Lies glow a different colour.",     descriptionKo: "장막을 꿰뚫어본다. 숨겨진 것들이 드러난다. 거짓말이 다른 색으로 빛난다.", statBonus: "cunning",   bonusValue: 4,              cooldown: 2, currentCooldown: 0 },
    { id: "dread_voice",        skillType: "social",   name: "Dread Voice",         nameKo: "공포의 목소리",   description: "Your words carry an edge of the abyss. People comply because some part of them knows better.", descriptionKo: "당신의 말에 심연의 날이 실린다. 사람들이 따르는 것은 어딘가의 본능이 더 잘 알기 때문이다.", statBonus: "reputation", bonusValue: 4, cooldown: 3, currentCooldown: 0, statRequirement: { stat: "reputation", min: 5 } },
  ],
  Drifter: [
    { id: "read_the_room",      skillType: "combat",   name: "Read the Room",       nameKo: "상황 파악",       description: "Scan every exit, every face, every angle. You are never caught unaware.",                 descriptionKo: "모든 출구, 모든 얼굴, 모든 각도를 스캔한다. 절대 방심하지 않는다.",    statBonus: "cunning",    bonusValue: 4,              cooldown: 2, currentCooldown: 0 },
    { id: "sucker_punch",       skillType: "combat",   name: "Sucker Punch",        nameKo: "기습 펀치",       description: "Strike first. Strike hard. Leave before they recover.",                                   descriptionKo: "먼저 친다. 세게 친다. 회복하기 전에 떠난다.",                            statBonus: "strength",   bonusValue: 4,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "strength",   min: 5 } },
    { id: "dead_drop",          skillType: "survival", name: "Dead Drop",           nameKo: "비밀 은신처",     description: "Stash, hide, disappear. You always have a way out and a place to wait.",                  descriptionKo: "숨기고, 감추고, 사라진다. 항상 탈출구와 기다릴 곳이 있다.",              statBonus: "cunning",    bonusValue: 2, hpEffect: 10, cooldown: 3, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 7 } },
    { id: "ghost_step",         skillType: "survival", name: "Ghost Step",          nameKo: "유령 발걸음",     description: "No sound. No trace. You move through a room and leave nothing behind.",                   descriptionKo: "소리 없이. 흔적 없이. 방을 지나도 아무것도 남기지 않는다.",              statBonus: "cunning",    bonusValue: 2, hpEffect: 8,  cooldown: 2, currentCooldown: 0 },
    { id: "fast_talk",          skillType: "utility",  name: "Fast Talk",           nameKo: "입담",            description: "Turn enemies into allies with silver words before they realise what happened.",            descriptionKo: "깨닫기 전에 은빛 말로 적을 아군으로 만든다.",                            statBonus: "cunning",    bonusValue: 3,              cooldown: 2, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 6 } },
    { id: "reputation_game",    skillType: "social",   name: "Reputation Game",     nameKo: "명성 게임",       description: "You know how rumour spreads. You plant what you need and let people talk.",                 descriptionKo: "소문이 어떻게 퍼지는지 안다. 필요한 것을 심어두고 사람들이 떠들게 놔둔다.", statBonus: "reputation", bonusValue: 4, cooldown: 3, currentCooldown: 0 },
  ],
  Alchemist: [
    { id: "flashbomb",          skillType: "combat",   name: "Flash Bomb",          nameKo: "섬광탄",          description: "A blinding explosion of chemical light. Enemies stumble in the aftermath.",               descriptionKo: "화학적 빛의 폭발. 적들이 여파 속에 비틀거린다.",                         statBonus: "cunning",    bonusValue: 3,              cooldown: 3, currentCooldown: 0 },
    { id: "acid_splash",        skillType: "combat",   name: "Acid Splash",         nameKo: "산성 스플래시",   description: "Hurl corrosive compound. Armor dissolves. Flesh follows.",                                 descriptionKo: "부식성 화합물을 던진다. 갑옷이 녹는다. 살이 뒤따른다.",                   statBonus: "cunning",    bonusValue: 5,              cooldown: 3, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 8 } },
    { id: "vitalizing_draught", skillType: "survival", name: "Vitalizing Draught",  nameKo: "활력 물약",       description: "A brew of accelerated healing that knits wounds faster than they open.",                  descriptionKo: "상처가 벌어지는 속도보다 빠르게 아무는 가속 치유 물약.",                statBonus: "cunning",    bonusValue: 1, hpEffect: 20, cooldown: 3, currentCooldown: 0 },
    { id: "toxin_ward",         skillType: "survival", name: "Toxin Ward",          nameKo: "독소 결계",       description: "Inoculate yourself. Poisons, venoms, and infections find no purchase.",                   descriptionKo: "자신을 예방 접종한다. 독, 독액, 감염이 발판을 찾지 못한다.",              statBonus: "will",       bonusValue: 2, hpEffect: 12, cooldown: 3, currentCooldown: 0 },
    { id: "master_brewer",      skillType: "utility",  name: "Master Brewer",       nameKo: "마스터 브루어",   description: "Your knowledge of compounds unlocks possibilities others call impossible.",               descriptionKo: "화합물에 대한 지식이 남들이 불가능하다고 부르는 가능성을 열어준다.",      statBonus: "cunning",    bonusValue: 4,              cooldown: 2, currentCooldown: 0, statRequirement: { stat: "cunning",    min: 9 } },
    { id: "merchants_charm",    skillType: "social",   name: "Merchant's Charm",    nameKo: "상인의 매력",     description: "You know what people want and how to make them think you have it.",                        descriptionKo: "사람들이 원하는 것과 당신이 그것을 갖고 있다고 생각하게 하는 방법을 안다.", statBonus: "reputation", bonusValue: 4, cooldown: 3, currentCooldown: 0, statRequirement: { stat: "reputation", min: 6 } },
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
Grant items via "itemsGained": [...] when narratively earned. Maximum 2 items per turn. Grant sparingly — only when the story truly earns it.
Occasions: enemy defeated (drop loot 30% chance), NPC gift/trade, exploration discovery, special action reward.

Item types:
- "consumable": single-use, immediate effect on use (hp heal/harm, temp stat change). Examples: healing potion, antidote, strength elixir
- "equipment": passive stat bonus while equipped. Effect = permanent bonus. Examples: iron gauntlet (+2 strength), thief's ring (+2 cunning)
- "key_item": narrative unlock, no stat effect. Include "condition" as comma-separated keywords that trigger usability. Examples: forged pass, governor's seal, encrypted data chip

Rarity & effect guidelines:
- common: hp ±15-25 OR ±1 stat | uncommon: hp ±25-40 OR ±2 stats | rare: hp ±40-60 OR ±3 stats | legendary: transformative

Item JSON format (include in "itemsGained" array):
{ "id": "unique_snake_case_id", "name": "English Name", "nameKo": "한국어 이름", "description": "Brief English desc.", "descriptionKo": "한국어 설명.", "type": "consumable|equipment|key_item", "rarity": "common|uncommon|rare|legendary", "icon": "emoji", "effect": {"hp":0,"strength":0,"cunning":0,"will":0,"reputation":0}, "quantity": 1, "situational": false, "condition": "" }

Rules: Do NOT include "itemsGained" unless granting items this turn. Never grant duplicate items.

═══ KEY ITEM SYSTEM ═══
Key items are RARE and PRECIOUS — grant them only at critical story turning points (maximum 1 per 8 turns).
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
"itemsGained": [...] 를 통해 서사적으로 획득했을 때 아이템을 부여하세요. 턴당 최대 2개. 아껴서 부여하세요.
기회: 적 처치 (30% 확률 아이템 드롭), NPC 선물/거래, 탐험 발견, 특수 행동 보상.

아이템 종류:
- "consumable": 1회 사용, 즉시 효과 (hp 회복/손상, 스탯 변화). 예: 치유 물약, 해독제, 힘의 엘릭서
- "equipment": 장착 중 지속 스탯 보너스. 예: 철제 건틀렛 (+2 strength), 도적의 반지 (+2 cunning)
- "key_item": 서사적 잠금 해제, 스탯 효과 없음. "condition"에 사용 가능 조건 키워드(쉼표 구분) 포함. 예: 위조 통행증, 총독의 인장

아이템 JSON 형식 ("itemsGained" 배열에 포함):
{ "id": "고유_식별자", "name": "English Name", "nameKo": "한국어 이름", "description": "영어 설명.", "descriptionKo": "한국어 설명.", "type": "consumable|equipment|key_item", "rarity": "common|uncommon|rare|legendary", "icon": "이모지", "effect": {"hp":0,"strength":0,"cunning":0,"will":0,"reputation":0}, "quantity": 1, "situational": false, "condition": "" }

규칙: 이번 턴에 아이템을 부여하지 않으면 "itemsGained" 포함 불필요. 중복 아이템 금지.

═══ 핵심 아이템 시스템 ═══
핵심 아이템은 희귀하고 귀합니다 — 이야기의 결정적 전환점에서만 부여하세요 (최대 8턴당 1개).
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
    stats = {
      ...stats,
      strength:   str ? parseInt(str)   : stats.strength,
      cunning:    cun ? parseInt(cun)   : stats.cunning,
      will:       wil ? parseInt(wil)   : stats.will,
      reputation: rep ? parseInt(rep)   : stats.reputation,
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
    const { genre = "fantasy", characterClass, playerName, lang = "en", skillIds, customStats } = req.body;
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

    const openingPrompt = lang === "ko"
      ? `장르 톤: ${genre}\n캐릭터 역할(행동 방식 렌즈, 세계 설정이 아님): ${classStr || "모험가"}\n스탯: HP ${startingStats.hp}/${startingStats.maxHp}, 힘 ${startingStats.strength}, 교활 ${startingStats.cunning}, 의지 ${startingStats.will}, 명성 ${startingStats.reputation}\n스킬: ${skillsInfo}\n\n직업에 얽매이지 말고 완전히 새롭고 독창적인 세계와 시나리오를 창조하세요. 이 직업을 가진 캐릭터가 어울리지 않아 보이는 예상치 못한 배경이면 더욱 좋습니다. 다중 단계가 필요한 복잡하고 구체적인 최종 목표("goal", "goalShort")를 정의하고, 분위기와 긴장감으로 이야기를 시작하세요.\n\n첫 번째 선택지 3가지는 반드시 서로 다른 행동 유형이어야 합니다: 하나는 힘/전투, 하나는 은신/기만, 하나는 이동/탐험. 그리고 현재 위치에서 도달 가능한 2~3개의 인접 구역을 암시하세요.`
      : `Genre tone: ${genre}\nCharacter role (action-style lens, NOT world setting): ${classStr || "Adventurer"}\nStats: HP ${startingStats.hp}/${startingStats.maxHp}, STR ${startingStats.strength}, CUN ${startingStats.cunning}, WIL ${startingStats.will}, REP ${startingStats.reputation}\nSkills: ${skillsInfo}\n\nIgnore any genre assumptions tied to the class. Build a completely original world that this character would have no obvious reason to be in — the unexpected combination is the point. Define a complex, multi-step final goal ("goal", "goalShort") requiring at least 4 distinct phases to achieve. Open with atmosphere and tension.\n\nThe first 3 choices MUST be different action types: one Force/Combat, one Stealth/Deception, one Movement/Exploration. Hint at 2-3 adjacent zones the player could reach from the starting location.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: openingPrompt }],
      response_format: { type: "json_object" },
      temperature: 1.0,
    });

    const raw = completion.choices[0].message.content ?? "{}";
    const data = JSON.parse(raw);

    // Opening scene is NEVER in combat — override any AI mistakes
    data.inCombat     = false;
    data.enemy        = null;
    data.enemyChanges = { hp: 0 };

    // Store goal in player meta
    const goal      = data.goal      ?? (lang === "ko" ? "알 수 없는 목표" : "Complete your mission");
    const goalShort = data.goalShort ?? (lang === "ko" ? "임무를 완수하라" : "Complete your mission");
    playerMetas.set(session.id, { name: playerName || "", characterClass: classStr, skills, goal, goalShort });

    await db.insert(storyEntries).values({
      sessionId: session.id, entryType: "narration", content: JSON.stringify(data),
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

    const entries    = await db.select().from(storyEntries).where(eq(storyEntries.sessionId, id));
    const baseStats  = statsMap.get(id) || DEFAULT_STATS;
    const inventory  = inventoryMap.get(id) ?? [];
    const stats      = applyEquipmentBonuses(baseStats, inventory);
    const playerMeta = playerMetas.get(id);
    const enemy      = enemyMap.get(id) ?? null;

    // Reconstruct world events from DB if not in memory (e.g. after server restart)
    if (!worldEventsMap.has(id)) {
      const reconstructed = reconstructWorldEvents(entries);
      worldEventsMap.set(id, reconstructed);
    }
    const worldEvents = worldEventsMap.get(id) ?? [];

    res.json({ session, entries, stats, playerMeta, enemy, inventory, worldEvents });
  } catch (err) {
    req.log.error(err, "Error fetching game");
    res.status(500).json({ error: "Failed to fetch game" });
  }
});

router.post("/:id/choice", async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    if (isNaN(sessionId)) return res.status(400).json({ error: "Invalid session id" });
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

    const userMsg = `Player chose option ${choiceIndex + 1}: "${choiceText}"${skillNote}${keyItemNote}\n\nDICE ROLL: ${outcomeCtx}\nRolled: d20=${roll.raw}, ${roll.stat.toUpperCase()} modifier=${roll.modifier > 0 ? "+" : ""}${roll.modifier}, Total=${roll.total}${enemyNote}${goalNote}${inventoryNote}${worldMemoryNote}${skillsNote}\nPlayer stats: HP ${statsBeforeRoll.hp}/${statsBeforeRoll.maxHp}, STR ${statsBeforeRoll.strength}, CUN ${statsBeforeRoll.cunning}, WIL ${statsBeforeRoll.will}, REP ${statsBeforeRoll.reputation}\nTurn: ${session.turnCount + 1}`;

    messages.push({ role: "user", content: userMsg });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      response_format: { type: "json_object" },
      temperature: 0.95,
    });

    const rawResp    = completion.choices[0].message.content ?? "{}";
    const data       = JSON.parse(rawResp);
    const statChanges: StatChanges     = data.statChanges      || {};
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

    // Persist
    await db.insert(storyEntries).values([
      { sessionId, entryType: "choice", content: JSON.stringify({ index: choiceIndex, text: choiceText, context: userMsg }) },
      { sessionId, entryType: "narration", content: JSON.stringify(data), choiceIndex },
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
    const data    = JSON.parse(rawResp);
    const statChanges: StatChanges = data.statChanges || {};

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

    // Persist
    await db.insert(storyEntries).values([
      { sessionId, entryType: "choice", content: JSON.stringify({ text: `[Key Item: ${itemName}]`, context: userMsg }) },
      { sessionId, entryType: "narration", content: JSON.stringify(data), choiceIndex: -1 },
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
  stun:     { id: "stun",     name: "Stunned",  nameKo: "기절",    damagePerTurn: 0,  atkMod: 0,  defMod: 0  },
  burn:     { id: "burn",     name: "Burning",  nameKo: "화상",    damagePerTurn: 4,  atkMod: 0,  defMod: 0  },
  poison:   { id: "poison",   name: "Poisoned", nameKo: "중독",    damagePerTurn: 3,  atkMod: 0,  defMod: 0  },
  bleed:    { id: "bleed",    name: "Bleeding", nameKo: "출혈",    damagePerTurn: 2,  atkMod: 0,  defMod: 0  },
  decay:    { id: "decay",    name: "Decaying", nameKo: "부식",    damagePerTurn: 0,  atkMod: -2, defMod: -2 },
  weakened: { id: "weakened", name: "Weakened", nameKo: "약화",    damagePerTurn: 0,  atkMod: -2, defMod: 0  },
};

function makeStatus(id: StatusEffectId, duration: number): StatusEffect {
  return { ...STATUS_TEMPLATES[id], duration };
}

type CombatSkillFx = {
  bonusDamage:   number;
  selfDamage?:   number;
  selfHeal?:     number;
  skipCA?:       boolean;
  drainRatio?:   number;
  piercing?:     number;
  statusOnEnemy?: { id: StatusEffectId; duration: number };
};

const COMBAT_SKILL_FX: Record<string, CombatSkillFx> = {
  // Warrior
  battle_cry:          { bonusDamage: 4 },
  berserker_rage:      { bonusDamage: 9, selfDamage: 5 },
  iron_skin:           { bonusDamage: 0, selfHeal: 15, skipCA: true },
  last_stand:          { bonusDamage: 0, selfHeal: 20, skipCA: true },
  soldier_instinct:    { bonusDamage: 2, skipCA: true },
  warlord_presence:    { bonusDamage: 0, statusOnEnemy: { id: "weakened", duration: 2 } },
  // Rogue
  shadow_strike:       { bonusDamage: 6, skipCA: true, statusOnEnemy: { id: "stun",     duration: 1 } },
  smoke_bomb:          { bonusDamage: 0, skipCA: true },
  vanish:              { bonusDamage: 0, selfHeal: 8, skipCA: true },
  street_tough:        { bonusDamage: 3, selfHeal: 12 },
  lockpick:            { bonusDamage: 0, skipCA: true },
  silver_tongue:       { bonusDamage: 0, statusOnEnemy: { id: "weakened", duration: 2 } },
  // Mage
  arcane_surge:        { bonusDamage: 7, statusOnEnemy: { id: "burn",     duration: 2 } },
  chain_lightning:     { bonusDamage: 9, statusOnEnemy: { id: "stun",     duration: 1 } },
  mana_shield:         { bonusDamage: 0, selfHeal: 10, skipCA: true },
  spell_recovery:      { bonusDamage: 0, selfHeal: 18, skipCA: true },
  arcane_sight:        { bonusDamage: 0, skipCA: true },
  enchanting_words:    { bonusDamage: 0, statusOnEnemy: { id: "weakened", duration: 3 } },
  // Paladin
  holy_strike:         { bonusDamage: 6 },
  divine_smite:        { bonusDamage: 10 },
  lay_on_hands:        { bonusDamage: 0, selfHeal: 22 },
  divine_protection:   { bonusDamage: 0, selfHeal: 15, skipCA: true },
  judgement:           { bonusDamage: 4, statusOnEnemy: { id: "weakened", duration: 2 } },
  blessed_presence:    { bonusDamage: 0, skipCA: true },
  // Ranger
  precision_shot:      { bonusDamage: 4, piercing: 3, statusOnEnemy: { id: "bleed",    duration: 3 } },
  volley:              { bonusDamage: 6, statusOnEnemy: { id: "bleed",    duration: 2 } },
  beast_bond:          { bonusDamage: 5 },
  camouflage:          { bonusDamage: 0, selfHeal: 8, skipCA: true },
  trackmaster:         { bonusDamage: 0, skipCA: true },
  hunters_mark:        { bonusDamage: 3, piercing: 2 },
  // Necromancer
  soul_drain:          { bonusDamage: 5, drainRatio: 0.5 },
  deaths_embrace:      { bonusDamage: 4, statusOnEnemy: { id: "decay",    duration: 3 } },
  bone_ward:           { bonusDamage: 0, selfHeal: 12, skipCA: true },
  undying:             { bonusDamage: 0, selfHeal: 22, skipCA: true },
  dark_ritual:         { bonusDamage: 0, statusOnEnemy: { id: "decay",    duration: 2 } },
  terrifying_visage:   { bonusDamage: 0, skipCA: true, statusOnEnemy: { id: "weakened", duration: 2 } },
  // Bard
  dissonant_whisper:   { bonusDamage: 3, skipCA: true, statusOnEnemy: { id: "weakened", duration: 2 } },
  blade_song:          { bonusDamage: 5, statusOnEnemy: { id: "stun",     duration: 1 } },
  healing_word:        { bonusDamage: 0, selfHeal: 18 },
  countercharm:        { bonusDamage: 0, selfHeal: 10, skipCA: true },
  bardic_knowledge:    { bonusDamage: 0, skipCA: true },
  inspire:             { bonusDamage: 0, selfHeal: 5 },
  // Druid
  natures_wrath:       { bonusDamage: 6, statusOnEnemy: { id: "poison",   duration: 3 } },
  thorn_whip:          { bonusDamage: 5, statusOnEnemy: { id: "bleed",    duration: 2 } },
  regrowth:            { bonusDamage: 0, selfHeal: 24 },
  wild_form:           { bonusDamage: 0, selfHeal: 16, skipCA: true },
  commune_nature:      { bonusDamage: 0, skipCA: true },
  earthen_tongue:      { bonusDamage: 0, statusOnEnemy: { id: "weakened", duration: 2 } },
  // Ironclad
  iron_bulwark:        { bonusDamage: 3, selfHeal: 12 },
  armor_crush:         { bonusDamage: 8, piercing: 5 },
  juggernaut:          { bonusDamage: 4, selfHeal: 18 },
  pain_tolerance:      { bonusDamage: 0, selfHeal: 10, skipCA: true },
  combat_sense:        { bonusDamage: 2, skipCA: true },
  unyielding:          { bonusDamage: 0, skipCA: true, statusOnEnemy: { id: "weakened", duration: 2 } },
  // Hexblade
  cursed_strike:       { bonusDamage: 5, statusOnEnemy: { id: "bleed",    duration: 4 } },
  hex_bolt:            { bonusDamage: 8, statusOnEnemy: { id: "decay",    duration: 2 } },
  hex_leech:           { bonusDamage: 5, drainRatio: 0.55 },
  curse_ward:          { bonusDamage: 0, selfHeal: 16, skipCA: true },
  eldritch_sight:      { bonusDamage: 0, skipCA: true },
  dread_voice:         { bonusDamage: 0, skipCA: true, statusOnEnemy: { id: "weakened", duration: 3 } },
  // Drifter
  read_the_room:       { bonusDamage: 0, skipCA: true },
  sucker_punch:        { bonusDamage: 6, skipCA: true, statusOnEnemy: { id: "stun",     duration: 1 } },
  dead_drop:           { bonusDamage: 0, selfHeal: 10, skipCA: true },
  ghost_step:          { bonusDamage: 0, selfHeal: 8, skipCA: true },
  fast_talk:           { bonusDamage: 0, skipCA: true },
  reputation_game:     { bonusDamage: 0, statusOnEnemy: { id: "weakened", duration: 2 } },
  // Alchemist
  flashbomb:           { bonusDamage: 3, skipCA: true, statusOnEnemy: { id: "stun",     duration: 1 } },
  acid_splash:         { bonusDamage: 7, statusOnEnemy: { id: "decay",    duration: 3 } },
  vitalizing_draught:  { bonusDamage: 0, selfHeal: 20 },
  toxin_ward:          { bonusDamage: 0, selfHeal: 12, skipCA: true },
  master_brewer:       { bonusDamage: 0, skipCA: true },
  merchants_charm:     { bonusDamage: 0, statusOnEnemy: { id: "weakened", duration: 2 } },
};

function d6(): number { return Math.floor(Math.random() * 6) + 1; }
function playerDefRating(stats: Stats): number {
  return Math.floor((stats.strength + stats.will) / 5);
}

// ─── POST /:id/combat-action ──────────────────────────────────────────────────
router.post("/:id/combat-action", async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    if (isNaN(sessionId)) return res.status(400).json({ error: "Invalid session id" });

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
      if (se.duration - 1 > 0) tickedEnemy.push({ ...se, duration: se.duration - 1 });
    }
    sfx = { ...sfx, enemy: tickedEnemy };

    // ── Resolve player action ────────────────────────────────────────────────
    if (action === "attack") {
      const roll6 = d6();
      const crit20 = Math.floor(Math.random() * 20) + 1;
      isCritical = crit20 >= 18;
      isFumble   = crit20 <= 2;
      let dmg = newStats.strength + roll6 - effEnemyDef;
      if (isCritical) dmg = Math.round(dmg * 1.6);
      if (isFumble)   dmg = Math.max(0, Math.round(dmg * 0.4));
      playerDamage = Math.max(1, dmg);
      combatLog.push(lang === "ko"
        ? `⚔ ${isCritical ? "치명타! " : isFumble ? "실수... " : ""}적에게 ${playerDamage} 피해.`
        : `⚔ ${isCritical ? "Critical hit! " : isFumble ? "Fumble... " : ""}Dealt ${playerDamage} damage.`);

    } else if (action === "defend") {
      defended = true;
      skipCA   = true;  // handled here with bonus def
      const roll6 = d6();
      damageTaken = Math.max(1, effEnemyAtk + roll6 - basePlayerDef - 4);
      combatLog.push(lang === "ko"
        ? `🛡 방어 자세! 적의 공격을 ${damageTaken} 피해로 흡수했습니다.`
        : `🛡 Defended! Absorbed the enemy's attack for ${damageTaken} damage.`);

    } else if (action === "skill") {
      usedSkill = skills.find(s => s.id === skillId && s.currentCooldown === 0);
      if (!usedSkill) return res.status(400).json({ error: "Skill on cooldown or not found" });

      const fx = COMBAT_SKILL_FX[skillId] ?? { bonusDamage: usedSkill.bonusValue };

      if (fx.bonusDamage > 0) {
        const roll6 = d6();
        const piercing = fx.piercing ?? 0;
        let dmg = newStats.strength + roll6 + fx.bonusDamage - Math.max(0, effEnemyDef - piercing);
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

      const skillLabel = lang === "ko" ? usedSkill.nameKo : usedSkill.name;
      combatLog.push(lang === "ko"
        ? `✨ ${skillLabel} 사용!${playerDamage > 0 ? ` 적에게 ${playerDamage} 피해.` : ""}${fx.selfDamage ? ` 자기 피해 ${fx.selfDamage}.` : ""}${healAmount > 0 ? ` HP +${healAmount}.` : ""}${statusOnEnemy ? ` [${statusOnEnemy.nameKo}] 부여.` : ""}${skipCA ? " 반격 회피!" : ""}`
        : `✨ Used ${skillLabel}!${playerDamage > 0 ? ` Dealt ${playerDamage} dmg.` : ""}${fx.selfDamage ? ` Self: -${fx.selfDamage} HP.` : ""}${healAmount > 0 ? ` Healed ${healAmount} HP.` : ""}${statusOnEnemy ? ` Applied [${statusOnEnemy.name}].` : ""}${skipCA ? " Avoids retaliation!" : ""}`);

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
        damageTaken += Math.max(1, effEnemyAtk + roll6 - basePlayerDef);
        combatLog.push(lang === "ko"
          ? `💥 적의 반격: ${damageTaken} 피해.`
          : `💥 Enemy counterattacked: ${damageTaken} dmg.`);
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

    await db.insert(storyEntries).values([
      { sessionId, entryType: "choice", content: JSON.stringify({ text: `[Combat: ${actionLabel}]`, context: combatSummary }) },
      { sessionId, entryType: "narration", content: JSON.stringify(aiData), choiceIndex: -1 },
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
  }
});

export default router;


export type Stats = {
  hp: number;
  maxHp: number;
  strength: number;
  cunning: number;
  will: number;
  reputation: number;
};

export type StatChanges = {
  hp?: number;
  strength?: number;
  cunning?: number;
  will?: number;
  reputation?: number;
};

export type DiceOutcome =
  | "critical_failure"
  | "failure"
  | "partial"
  | "success"
  | "critical_success";

export type RollResult = {
  raw: number;
  stat: keyof Omit<Stats, "hp" | "maxHp">;
  statValue: number;
  modifier: number;
  total: number;
  outcome: DiceOutcome;
};

export type SkillType = "combat" | "survival" | "utility" | "social";

export type Skill = {
  id: string;
  name: string;
  nameKo: string;
  description: string;
  descriptionKo: string;
  skillType: SkillType;
  statBonus: keyof Omit<Stats, "hp" | "maxHp">;
  bonusValue: number;
  hpEffect?: number;
  cooldown: number;
  currentCooldown: number;
  statRequirement?: { stat: keyof Omit<Stats, "hp" | "maxHp">; min: number };
  available?: boolean; // set by server for skill-pool response
  enhanced?: boolean;
};

export type SkillUpgradeOption = {
  type: "enhance" | "transform";
  skillId: string;
  toSkillId?: string;
  name: string;
  nameKo: string;
  description: string;
  descriptionKo: string;
};

// ─── Status effects ────────────────────────────────────────────────────────────

export type StatusEffectId = "stun" | "burn" | "poison" | "bleed" | "decay" | "weakened" | "torment";

export type StatusEffect = {
  id: StatusEffectId;
  name: string;
  nameKo: string;
  damagePerTurn: number;   // flat HP lost per round
  maxHpPercent?: number;   // % of target's max HP lost per round (e.g. 5 = 5%)
  atkMod: number;          // negative = reduced attack
  defMod: number;          // negative = reduced defense
  duration: number;        // rounds remaining
};

// ─── Enemy ────────────────────────────────────────────────────────────────────

export type Enemy = {
  name: string;
  nameKo?: string;
  hp: number;
  maxHp: number;
  attack: number;
  defense: number;
  statusEffects?: StatusEffect[];
};

export type EnemyChanges = {
  hp?: number;
};

// ─── Item system ───────────────────────────────────────────────────────────────

export type ItemType    = "consumable" | "equipment" | "key_item";
export type ItemRarity  = "common" | "uncommon" | "rare" | "legendary";

export type ItemEffect = {
  hp?:         number;
  strength?:   number;
  cunning?:    number;
  will?:       number;
  reputation?: number;
  damage?:     number;  // combat damage (e.g. throwable)
};

export type Item = {
  id:           string;
  name:         string;
  nameKo:       string;
  description:  string;
  descriptionKo: string;
  type:         ItemType;
  rarity:       ItemRarity;
  icon:         string;
  effect:       ItemEffect;
  equipped?:    boolean;
  quantity:     number;
  situational?: boolean;
  condition?:   string;
};

// ─── Combat ───────────────────────────────────────────────────────────────────

export type CombatAction = "attack" | "defend" | "skill" | "item" | "flee";

export type CombatResult = {
  playerDamage:    number;   // damage dealt to enemy
  damageTaken:     number;   // damage from enemy counterattack
  selfDamage:      number;   // self-inflicted (berserker, etc.)
  healAmount:      number;   // HP healed
  isCritical:      boolean;
  isFumble:        boolean;
  defended:        boolean;
  fled:            boolean;
  fleeSuccess:     boolean;
  enemyStunned:    boolean;
  statusOnEnemy:   StatusEffect | null;
  statusOnPlayer:  StatusEffect | null;
  combatLog:       string[];
};

// ─── API response types ────────────────────────────────────────────────────────

export type KeyItemChoice = {
  itemId:     string;
  choiceText: string;
};

export type SkillChoice = {
  skillId:    string;
  choiceText: string;
};

export type LevelUpData = {
  upgradeOptions: SkillUpgradeOption[];
};

export type StoryResponse = {
  narration:              string;
  choices:                string[];
  statChanges?:           StatChanges;
  worldConsequences?:     StatChanges;
  worldConsequenceDesc?:  string;
  isEnding?:              boolean;
  goalAchieved?:          boolean;
  goal?:                  string;
  goalShort?:             string;
  roll?:                  RollResult;
  stats?:                 Stats;
  skills?:                Skill[];
  enemy?:                 Enemy | null;
  enemyChanges?:          EnemyChanges;
  inCombat?:              boolean;
  itemsGained?:           Item[];
  inventory?:             Item[];
  combatResult?:          CombatResult;
  worldEvents?:           string[];
  keyItemChoices?:        KeyItemChoice[];
  skillChoices?:          SkillChoice[];
  expiredKeyItemNames?:   string[];
  levelUp?:               LevelUpData;
};

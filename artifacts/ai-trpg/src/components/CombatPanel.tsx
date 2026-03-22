import { memo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sword, Shield, Zap, ShoppingBag, Wind, ChevronDown, ChevronUp } from "lucide-react";
import type { Stats, Enemy, Skill, Item, StatusEffect } from "@/types";
import { useLang } from "@/lib/i18n";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statMod(v: number): number { return Math.floor((v - 5) / 2); }
function playerDefRating(stats: Stats): number {
  return Math.floor((stats.strength + stats.will) / 5);
}

function attackRange(stats: Stats, enemy: Enemy): { min: number; max: number } {
  const effDef = Math.max(0, enemy.defense + effectiveEnemyStatMod(enemy));
  const min = Math.max(1, stats.strength + 1 - effDef);
  const max = Math.max(1, stats.strength + 6 - effDef);
  return { min, max };
}

function skillAttackRange(stats: Stats, enemy: Enemy, _skill: Skill, bonusDmg: number, piercing = 0): { min: number; max: number } {
  const effDef = Math.max(0, enemy.defense - piercing + effectiveEnemyStatMod(enemy));
  const min = Math.max(1, stats.strength + 1 + bonusDmg - effDef);
  const max = Math.max(1, stats.strength + 6 + bonusDmg - effDef);
  return { min, max };
}

function effectiveEnemyStatMod(enemy: Enemy): number {
  let defMod = 0;
  for (const se of enemy.statusEffects ?? []) defMod += se.defMod;
  return defMod;
}

function defendRange(stats: Stats, enemy: Enemy): { min: number; max: number } {
  const def = playerDefRating(stats) + 4;
  const effAtk = Math.max(0, enemy.attack + effectiveEnemyAtkMod(enemy));
  const min = Math.max(1, effAtk + 1 - def);
  const max = Math.max(1, effAtk + 6 - def);
  return { min, max };
}

function normalIncomingRange(stats: Stats, enemy: Enemy): { min: number; max: number } {
  const def = playerDefRating(stats);
  const effAtk = Math.max(0, enemy.attack + effectiveEnemyAtkMod(enemy));
  const min = Math.max(1, effAtk + 1 - def);
  const max = Math.max(1, effAtk + 6 - def);
  return { min, max };
}

function effectiveEnemyAtkMod(enemy: Enemy): number {
  let mod = 0;
  for (const se of enemy.statusEffects ?? []) mod += se.atkMod;
  return mod;
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  stun:     "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  burn:     "bg-orange-500/20 text-orange-300 border-orange-500/30",
  poison:   "bg-green-500/20 text-green-300 border-green-500/30",
  bleed:    "bg-red-500/20 text-red-300 border-red-500/30",
  decay:    "bg-purple-500/20 text-purple-300 border-purple-500/30",
  weakened: "bg-slate-500/20 text-slate-300 border-slate-500/30",
};

const STATUS_ICONS: Record<string, string> = {
  stun: "😵", burn: "🔥", poison: "☠", bleed: "🩸", decay: "💀", weakened: "💧",
};

function StatusBadge({ se, lang }: { se: StatusEffect; lang: string }) {
  const cls = STATUS_COLORS[se.id] ?? "bg-white/10 text-white/60 border-white/10";
  const icon = STATUS_ICONS[se.id] ?? "⚡";
  const label = lang === "ko" ? se.nameKo : se.name;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border font-semibold ${cls}`}>
      {icon} {label} ×{se.duration}
    </span>
  );
}

// ─── Combat Log ───────────────────────────────────────────────────────────────

function CombatLog({ entries }: { entries: string[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="mt-2 space-y-0.5">
      {entries.map((line, i) => (
        <p key={i} className="text-[11px] text-white/50 font-mono leading-relaxed">{line}</p>
      ))}
    </div>
  );
}

// ─── Skill combat effects map (mirrors server) ────────────────────────────────

const SKILL_FX_PREVIEW: Record<string, { bonusDamage: number; selfHeal?: number; selfDamage?: number; skipCA?: boolean; piercing?: number }> = {
  battle_cry:        { bonusDamage: 4 },
  berserker_rage:    { bonusDamage: 9, selfDamage: 5 },
  shadow_strike:     { bonusDamage: 6, skipCA: true },
  smoke_bomb:        { bonusDamage: 0, skipCA: true },
  arcane_surge:      { bonusDamage: 7 },
  mana_shield:       { bonusDamage: 0, selfHeal: 10, skipCA: true },
  holy_strike:       { bonusDamage: 6 },
  lay_on_hands:      { bonusDamage: 0, selfHeal: 22 },
  precision_shot:    { bonusDamage: 4, piercing: 3 },
  beast_bond:        { bonusDamage: 5 },
  soul_drain:        { bonusDamage: 5 },
  deaths_embrace:    { bonusDamage: 4 },
  dissonant_whisper: { bonusDamage: 3, skipCA: true },
  healing_word:      { bonusDamage: 0, selfHeal: 18 },
  natures_wrath:     { bonusDamage: 6 },
  regrowth:          { bonusDamage: 0, selfHeal: 24 },
  iron_bulwark:      { bonusDamage: 3, selfHeal: 12 },
  armor_crush:       { bonusDamage: 8, piercing: 5 },
  cursed_strike:     { bonusDamage: 5 },
  hex_leech:         { bonusDamage: 5 },
  read_the_room:     { bonusDamage: 0, skipCA: true },
  fast_talk:         { bonusDamage: 0, skipCA: true },
  flashbomb:         { bonusDamage: 3, skipCA: true },
  vitalizing_draught:{ bonusDamage: 0, selfHeal: 20 },
};

// ─── Props ────────────────────────────────────────────────────────────────────

type Props = {
  stats: Stats;
  enemy: Enemy;
  skills: Skill[];
  inventory: Item[];
  isPending: boolean;
  lastCombatLog?: string[];
  onAction: (action: "attack" | "defend" | "skill" | "item" | "flee", skillId?: string, itemId?: string) => void;
};

export const CombatPanel = memo(function CombatPanel({
  stats, enemy, skills, inventory, isPending, lastCombatLog = [], onAction,
}: Props) {
  const { lang } = useLang();
  const [showSkills, setShowSkills] = useState(false);
  const [showItems,  setShowItems]  = useState(false);

  const atk = attackRange(stats, enemy);
  const def = defendRange(stats, enemy);
  const inc = normalIncomingRange(stats, enemy);
  const readySkills = skills.filter(s => s.currentCooldown === 0);
  const consumables = inventory.filter(i => i.type === "consumable" && i.quantity > 0);
  const isStunned   = (enemy.statusEffects ?? []).some(s => s.id === "stun");

  const t = (en: string, ko: string) => lang === "ko" ? ko : en;

  return (
    <div className="mt-4 space-y-3">

      {/* Enemy status effects */}
      {(enemy.statusEffects ?? []).length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1">
          {(enemy.statusEffects ?? []).map(se => (
            <StatusBadge key={se.id} se={se} lang={lang} />
          ))}
        </div>
      )}

      {/* Main action row */}
      <div className="grid grid-cols-2 gap-2">

        {/* Attack */}
        <motion.button
          whileTap={{ scale: 0.97 }}
          disabled={isPending}
          onClick={() => onAction("attack")}
          className="relative flex flex-col items-start gap-0.5 px-3 py-2.5 rounded-lg border border-red-500/40 bg-red-950/30 hover:bg-red-900/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-left"
        >
          <div className="flex items-center gap-1.5">
            <Sword className="w-3.5 h-3.5 text-red-400 shrink-0" />
            <span className="text-sm font-semibold text-red-300">{t("Attack", "공격")}</span>
          </div>
          <span className="text-[11px] text-white/50">
            ~{atk.min}–{atk.max} dmg
            {isStunned && <span className="ml-1 text-yellow-400">{t("(stunned)", "(기절)")}</span>}
          </span>
          <span className="text-[10px] text-white/30">{t("uses STR", "STR 사용")}</span>
        </motion.button>

        {/* Defend */}
        <motion.button
          whileTap={{ scale: 0.97 }}
          disabled={isPending}
          onClick={() => onAction("defend")}
          className="relative flex flex-col items-start gap-0.5 px-3 py-2.5 rounded-lg border border-blue-500/40 bg-blue-950/30 hover:bg-blue-900/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-left"
        >
          <div className="flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span className="text-sm font-semibold text-blue-300">{t("Defend", "방어")}</span>
          </div>
          <span className="text-[11px] text-white/50">
            {t("take", "받는")} ~{def.min}–{def.max} dmg
            <span className="text-green-400 ml-1">
              {t(`vs ~${inc.min}–${inc.max}`, `일반 ~${inc.min}–${inc.max}`)}
            </span>
          </span>
          <span className="text-[10px] text-white/30">{t("+4 DEF bonus", "+4 방어 보너스")}</span>
        </motion.button>
      </div>

      {/* Skills section */}
      <div>
        <button
          onClick={() => setShowSkills(v => !v)}
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-violet-500/30 bg-violet-950/20 hover:bg-violet-900/30 transition-colors text-left"
        >
          <div className="flex items-center gap-2">
            <Zap className="w-3.5 h-3.5 text-violet-400" />
            <span className="text-sm font-semibold text-violet-300">
              {t("Skills", "스킬")}
              {readySkills.length > 0 && (
                <span className="ml-1.5 text-[11px] font-normal text-violet-400/70">
                  ({readySkills.length} {t("ready", "사용 가능")})
                </span>
              )}
            </span>
          </div>
          {showSkills ? <ChevronUp className="w-3.5 h-3.5 text-white/40" /> : <ChevronDown className="w-3.5 h-3.5 text-white/40" />}
        </button>

        <AnimatePresence>
          {showSkills && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="overflow-hidden"
            >
              <div className="mt-1.5 space-y-1.5">
                {skills.map(skill => {
                  const onCd = skill.currentCooldown > 0;
                  const fx = SKILL_FX_PREVIEW[skill.id] ?? { bonusDamage: skill.bonusValue };
                  const hasDmg = fx.bonusDamage > 0;
                  const dmgRange = hasDmg ? skillAttackRange(stats, enemy, skill, fx.bonusDamage, fx.piercing) : null;
                  return (
                    <motion.button
                      key={skill.id}
                      whileTap={{ scale: 0.97 }}
                      disabled={isPending || onCd}
                      onClick={() => { onAction("skill", skill.id); setShowSkills(false); }}
                      className="w-full flex items-start justify-between gap-2 px-3 py-2 rounded-lg border border-violet-500/20 bg-violet-950/10 hover:bg-violet-900/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-left"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[13px] font-semibold text-violet-200">
                            {lang === "ko" ? skill.nameKo : skill.name}
                          </span>
                          {onCd && (
                            <span className="text-[10px] text-orange-400 font-mono">
                              CD {skill.currentCooldown}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-white/40 mt-0.5 line-clamp-1">
                          {lang === "ko" ? skill.descriptionKo : skill.description}
                        </p>
                      </div>
                      <div className="shrink-0 text-right text-[11px] text-white/50 space-y-0.5">
                        {dmgRange && (
                          <div className="text-red-300">~{dmgRange.min}–{dmgRange.max} dmg</div>
                        )}
                        {fx.selfHeal && (
                          <div className="text-green-300">+{fx.selfHeal} HP</div>
                        )}
                        {fx.selfDamage && (
                          <div className="text-orange-300">-{fx.selfDamage} HP self</div>
                        )}
                        {fx.skipCA && !dmgRange && !fx.selfHeal && (
                          <div className="text-blue-300">{t("dodge", "회피")}</div>
                        )}
                      </div>
                    </motion.button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Items section */}
      {consumables.length > 0 && (
        <div>
          <button
            onClick={() => setShowItems(v => !v)}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-950/20 hover:bg-amber-900/30 transition-colors text-left"
          >
            <div className="flex items-center gap-2">
              <ShoppingBag className="w-3.5 h-3.5 text-amber-400" />
              <span className="text-sm font-semibold text-amber-300">
                {t("Use Item", "아이템 사용")}
                <span className="ml-1.5 text-[11px] font-normal text-amber-400/70">
                  ({consumables.length})
                </span>
              </span>
            </div>
            {showItems ? <ChevronUp className="w-3.5 h-3.5 text-white/40" /> : <ChevronDown className="w-3.5 h-3.5 text-white/40" />}
          </button>
          <AnimatePresence>
            {showItems && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="overflow-hidden"
              >
                <div className="mt-1.5 space-y-1.5">
                  {consumables.map(item => (
                    <motion.button
                      key={item.id}
                      whileTap={{ scale: 0.97 }}
                      disabled={isPending}
                      onClick={() => { onAction("item", undefined, item.id); setShowItems(false); }}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-amber-500/20 bg-amber-950/10 hover:bg-amber-900/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-left"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-base leading-none">{item.icon}</span>
                        <div className="min-w-0">
                          <p className="text-[13px] font-semibold text-amber-200">
                            {lang === "ko" ? item.nameKo : item.name}
                            <span className="ml-1 text-[11px] font-normal text-white/40">×{item.quantity}</span>
                          </p>
                          <p className="text-[11px] text-white/40 line-clamp-1">
                            {lang === "ko" ? item.descriptionKo : item.description}
                          </p>
                        </div>
                      </div>
                      <div className="shrink-0 text-[11px] text-right space-y-0.5">
                        {item.effect.hp && item.effect.hp > 0 && (
                          <div className="text-green-300">+{item.effect.hp} HP</div>
                        )}
                        {item.effect.damage && item.effect.damage > 0 && (
                          <div className="text-red-300">~{Math.max(1, item.effect.damage - enemy.defense)} dmg</div>
                        )}
                      </div>
                    </motion.button>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Flee */}
      <motion.button
        whileTap={{ scale: 0.97 }}
        disabled={isPending}
        onClick={() => onAction("flee")}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <Wind className="w-3.5 h-3.5 text-white/50" />
        <span className="text-sm text-white/50">{t("Flee", "도주")}</span>
        <span className="text-[11px] text-white/30 ml-auto">
          {t(`CUN+d20 ≥ 11`, `CUN+d20 ≥ 11`)}
        </span>
      </motion.button>

      {/* Last round combat log */}
      {lastCombatLog.length > 0 && <CombatLog entries={lastCombatLog} />}

      {/* Pending overlay */}
      {isPending && (
        <div className="text-center text-[12px] text-white/40 animate-pulse">
          {t("Resolving...", "계산 중...")}
        </div>
      )}
    </div>
  );
});

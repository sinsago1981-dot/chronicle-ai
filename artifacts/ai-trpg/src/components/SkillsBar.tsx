import { memo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Skill } from "@/types";
import { useLang } from "@/lib/i18n";
import { Zap, Clock } from "lucide-react";

type Props = {
  skills: Skill[];
  selectedSkillId: string | null;
  onSelect: (skillId: string | null) => void;
  disabled?: boolean;
};

const STAT_LABEL: Record<string, { en: string; ko: string; color: string }> = {
  strength:   { en: "STR", ko: "힘",   color: "text-orange-400"  },
  cunning:    { en: "CUN", ko: "교활", color: "text-yellow-400"  },
  will:       { en: "WIL", ko: "의지", color: "text-violet-400"  },
  reputation: { en: "REP", ko: "명성", color: "text-sky-400"     },
};

export const SkillsBar = memo(function SkillsBar({
  skills, selectedSkillId, onSelect, disabled = false,
}: Props) {
  const { lang } = useLang();

  return (
    <div className="pt-1">
      <div className="flex items-center gap-1.5 mb-2">
        <Zap className="w-3 h-3 text-primary/60" />
        <span className="text-[10px] font-semibold tracking-wider text-muted-foreground/60 uppercase">
          {lang === "ko" ? "스킬" : "Skills"}
        </span>
      </div>
      <div className="flex gap-2">
        {skills.map(skill => {
          const onCooldown = skill.currentCooldown > 0;
          const isSelected = selectedSkillId === skill.id;
          const statInfo   = STAT_LABEL[skill.statBonus] ?? { en: skill.statBonus.toUpperCase(), ko: skill.statBonus, color: "text-primary" };
          const statLabel  = lang === "ko" ? statInfo.ko : statInfo.en;

          return (
            <motion.button
              key={skill.id}
              whileHover={!onCooldown && !disabled ? { scale: 1.03 } : {}}
              whileTap={!onCooldown && !disabled ? { scale: 0.97 } : {}}
              onClick={() => {
                if (onCooldown || disabled) return;
                onSelect(isSelected ? null : skill.id);
              }}
              className={`relative flex-1 text-left px-3 py-2.5 rounded-lg border transition-all duration-200 ${
                onCooldown || disabled
                  ? "opacity-40 cursor-not-allowed border-border/30 bg-muted/20"
                  : isSelected
                    ? "border-primary/70 bg-primary/15 shadow-[0_0_12px_rgba(0,0,0,0.3)]"
                    : "border-border/50 bg-card/80 hover:border-primary/40 hover:bg-primary/8 cursor-pointer"
              }`}
            >
              {/* Skill name */}
              <div className={`text-xs font-bold truncate mb-0.5 ${isSelected ? "text-primary" : "text-foreground/80"}`}>
                {lang === "ko" ? skill.nameKo : skill.name}
              </div>

              {/* Bonus badge */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className={`text-[10px] font-semibold ${statInfo.color}`}>
                  {statLabel} +{skill.bonusValue}
                </span>
                {skill.hpEffect !== undefined && skill.hpEffect > 0 && (
                  <span className="text-[10px] font-semibold text-green-400">
                    HP +{skill.hpEffect}
                  </span>
                )}
                {skill.hpEffect !== undefined && skill.hpEffect < 0 && (
                  <span className="text-[10px] font-semibold text-red-400">
                    HP {skill.hpEffect}
                  </span>
                )}
              </div>

              {/* Cooldown overlay */}
              <AnimatePresence>
                {onCooldown && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/40"
                  >
                    <div className="flex items-center gap-1 text-muted-foreground/60">
                      <Clock className="w-3 h-3" />
                      <span className="text-xs font-bold">{skill.currentCooldown}</span>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Selected ring */}
              {isSelected && (
                <motion.div
                  layoutId="skill-ring"
                  className="absolute inset-0 rounded-lg border-2 border-primary/60 pointer-events-none"
                />
              )}
            </motion.button>
          );
        })}
      </div>

      {/* Selected skill tooltip */}
      <AnimatePresence>
        {selectedSkillId && (() => {
          const sk = skills.find(s => s.id === selectedSkillId);
          if (!sk) return null;
          return (
            <motion.p
              key={selectedSkillId}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
              className="mt-1.5 text-[10px] text-muted-foreground/60 italic leading-relaxed"
            >
              {lang === "ko" ? sk.descriptionKo : sk.description}
              {sk.cooldown > 0 && (
                <span className="ml-1 text-muted-foreground/40">
                  ({lang === "ko" ? `쿨다운: ${sk.cooldown}턴` : `Cooldown: ${sk.cooldown} turns`})
                </span>
              )}
            </motion.p>
          );
        })()}
      </AnimatePresence>
    </div>
  );
});

import { memo, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Enemy, EnemyChanges } from "@/types";
import { Sword, Shield, Skull, Swords } from "lucide-react";
import { useLang } from "@/lib/i18n";

type Props = { enemy: Enemy; changes?: EnemyChanges };
type FloatingNum = { id: number; value: number };

const EnemyHpBar = memo(function EnemyHpBar({ hp, maxHp }: { hp: number; maxHp: number }) {
  const pct        = Math.max(0, Math.min(100, (hp / maxHp) * 100));
  const prevPctRef = useRef(pct);
  const [ghostPct, setGhostPct] = useState(pct);
  const ghostTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (pct < prevPctRef.current) {
      setGhostPct(prevPctRef.current);
      if (ghostTimer.current) clearTimeout(ghostTimer.current);
      ghostTimer.current = setTimeout(() => setGhostPct(pct), 350);
    } else {
      setGhostPct(pct);
    }
    prevPctRef.current = pct;
    return () => { if (ghostTimer.current) clearTimeout(ghostTimer.current); };
  }, [pct]);

  const barColor = pct > 60 ? "bg-red-600" : pct > 30 ? "bg-red-500" : "bg-red-400";
  const isLow    = pct <= 30;

  return (
    <div className="relative w-full h-5 bg-red-950/70 rounded-full overflow-hidden border border-red-900/40 shadow-inner">
      <motion.div
        className="absolute inset-y-0 left-0 rounded-full bg-orange-400/35"
        animate={{ width: `${ghostPct}%` }}
        transition={{ duration: 0.9, ease: "easeOut" }}
      />
      <motion.div
        className={`absolute inset-y-0 left-0 rounded-full ${barColor} ${isLow ? "animate-pulse" : ""}`}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.45, ease: "easeOut" }}
      />
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span className="text-[11px] font-black text-white/95 drop-shadow tracking-wider tabular-nums select-none">
          {hp} <span className="opacity-60 font-normal">/</span> {maxHp}
        </span>
      </div>
    </div>
  );
});

export const EnemyPanel = memo(function EnemyPanel({ enemy, changes }: Props) {
  const { lang } = useLang();
  const [floatingNums, setFloatingNums] = useState<FloatingNum[]>([]);
  const nextId  = useRef(0);
  const prevHp  = useRef(enemy.hp);

  useEffect(() => {
    const delta = enemy.hp - prevHp.current;
    prevHp.current = enemy.hp;
    if (delta !== 0) {
      const id = nextId.current++;
      setFloatingNums(prev => [...prev, { id, value: delta }]);
      setTimeout(() => setFloatingNums(prev => prev.filter(n => n.id !== id)), 1800);
    }
  }, [enemy.hp]);

  const pct = Math.max(0, Math.min(100, (enemy.hp / enemy.maxHp) * 100));

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="border-b border-red-900/50 bg-gradient-to-b from-red-950/30 to-red-950/10 backdrop-blur-sm"
    >
      <div className="relative max-w-3xl mx-auto px-4 py-2.5">

        <AnimatePresence>
          {floatingNums.map(n => (
            <motion.div
              key={n.id}
              initial={{ opacity: 1, y: 0, scale: 1.4 }}
              animate={{ opacity: 0, y: -56, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.6, ease: "easeOut" }}
              className={`pointer-events-none absolute right-6 top-0 text-3xl font-black drop-shadow-lg z-20 ${
                n.value < 0 ? "text-red-300" : "text-green-400"
              }`}
            >
              {n.value < 0 ? n.value : `+${n.value}`}
            </motion.div>
          ))}
        </AnimatePresence>

        <div className="flex items-center gap-3 mb-2">
          <div className="flex-1 h-px bg-red-900/40" />
          <div className="flex items-center gap-2 shrink-0">
            <Skull className="w-3.5 h-3.5 text-red-500/80" />
            <motion.span
              key={enemy.name}
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3 }}
              className="font-serif font-bold text-base text-red-200 tracking-wide text-center"
            >
              {lang === "ko" ? (enemy.nameKo ?? enemy.name) : enemy.name}
            </motion.span>
            <Swords className="w-3.5 h-3.5 text-red-500/80" />
          </div>
          <div className="flex-1 h-px bg-red-900/40" />
        </div>

        <div className="flex items-center gap-3">
          <div className="flex-1">
            <EnemyHpBar hp={enemy.hp} maxHp={enemy.maxHp} />
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-1">
              <Sword className="w-3 h-3 text-red-400/60" />
              <span className="text-xs font-bold tabular-nums text-red-300/80">{enemy.attack}</span>
            </div>
            <div className="flex items-center gap-1">
              <Shield className="w-3 h-3 text-red-400/60" />
              <span className="text-xs font-bold tabular-nums text-red-300/80">{enemy.defense}</span>
            </div>
          </div>
        </div>

        <div className="mt-1.5 flex items-center justify-center gap-3">
          {pct <= 30 && (
            <span className="text-[10px] text-red-400/80 animate-pulse font-semibold tracking-widest uppercase">
              ⚠ {lang === "ko" ? "빈사 상태" : "Near Death"}
            </span>
          )}
          <AnimatePresence>
            {changes?.hp !== undefined && changes.hp !== 0 && (
              <motion.span
                key={`last-hit-${changes.hp}`}
                initial={{ opacity: 0, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                className={`text-[11px] font-black px-2 py-0.5 rounded-full border ${
                  changes.hp < 0
                    ? "text-red-200 bg-red-900/60 border-red-700/50"
                    : "text-green-300 bg-green-900/50 border-green-700/50"
                }`}
              >
                {changes.hp < 0 ? `▼ ${Math.abs(changes.hp)} HP` : `▲ ${changes.hp} HP`}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
});

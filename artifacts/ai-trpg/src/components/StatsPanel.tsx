import { memo, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Stats, StatChanges } from "@/types";
import { useLang } from "@/lib/i18n";
import { Heart, Sword, Eye, Sparkles, Star } from "lucide-react";

type Props = { stats: Stats; latestChanges?: StatChanges; worldEffect?: StatChanges };

const HpBar = memo(function HpBar({ hp, maxHp }: { hp: number; maxHp: number }) {
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

  const color = pct > 50 ? "bg-green-500" : pct > 25 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="w-full h-2 bg-muted rounded-full overflow-hidden relative">
      <motion.div
        className="absolute inset-y-0 left-0 rounded-full bg-orange-400/40"
        animate={{ width: `${ghostPct}%` }}
        transition={{ duration: 0.9, ease: "easeOut" }}
      />
      <motion.div
        className={`absolute inset-y-0 left-0 rounded-full ${color}`}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      />
    </div>
  );
});

const StatPips = memo(function StatPips({ value }: { value: number }) {
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: 10 }, (_, i) => (
        <div
          key={i}
          className={`w-1 h-2.5 rounded-sm transition-colors duration-300 ${
            i < value ? "bg-primary" : "bg-muted"
          }`}
        />
      ))}
    </div>
  );
});

type FloatingNum = { id: number; value: number; x: number };

export const StatsPanel = memo(function StatsPanel({ stats, latestChanges = {}, worldEffect = {} }: Props) {
  const { t } = useLang();
  const sl = t.stats;
  const [floatingNums, setFloatingNums]   = useState<FloatingNum[]>([]);
  const [lastHpDelta,  setLastHpDelta]    = useState<number | null>(null);
  const nextId    = useRef(0);
  const prevHp    = useRef(stats.hp);
  const deltaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const delta = stats.hp - prevHp.current;
    prevHp.current = stats.hp;
    if (delta !== 0) {
      const id = nextId.current++;
      setFloatingNums(prev => [...prev, { id, value: delta, x: 30 + Math.random() * 40 }]);
      setTimeout(() => setFloatingNums(prev => prev.filter(n => n.id !== id)), 1800);
      setLastHpDelta(delta);
      if (deltaTimer.current) clearTimeout(deltaTimer.current);
      deltaTimer.current = setTimeout(() => setLastHpDelta(null), 4000);
    }
    return () => { if (deltaTimer.current) clearTimeout(deltaTimer.current); };
  }, [stats.hp]);

  const statRows = [
    { key: "strength"   as const, short: sl.strength,   icon: Sword,    value: stats.strength,   change: latestChanges.strength,   worldChange: worldEffect.strength   },
    { key: "cunning"    as const, short: sl.cunning,     icon: Eye,      value: stats.cunning,    change: latestChanges.cunning,    worldChange: worldEffect.cunning    },
    { key: "will"       as const, short: sl.will,        icon: Sparkles, value: stats.will,       change: latestChanges.will,       worldChange: worldEffect.will       },
    { key: "reputation" as const, short: sl.reputation,  icon: Star,     value: stats.reputation, change: latestChanges.reputation, worldChange: worldEffect.reputation },
  ];

  return (
    <div className="sticky top-14 z-[9] border-b border-border/50 bg-background/95 backdrop-blur-sm">
      <div className="relative max-w-3xl mx-auto px-4 py-2.5 space-y-2">

        {/* Floating HP damage/heal numbers */}
        <AnimatePresence>
          {floatingNums.map(n => (
            <motion.div
              key={n.id}
              initial={{ opacity: 1, y: 0, scale: 1 }}
              animate={{ opacity: 0, y: -48, scale: 1.2 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.6, ease: "easeOut" }}
              className={`pointer-events-none absolute top-0 text-xl font-black drop-shadow-lg z-20 ${
                n.value > 0 ? "text-green-400" : "text-red-400"
              }`}
              style={{ left: `${n.x}%` }}
            >
              {n.value > 0 ? `+${n.value}` : n.value}
            </motion.div>
          ))}
        </AnimatePresence>

        {/* HP row */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 shrink-0">
            <Heart className={`w-3.5 h-3.5 ${stats.hp < 20 ? "text-red-400 animate-pulse" : "text-primary"}`} />
            <span className="text-xs font-medium tabular-nums">
              <motion.span
                key={stats.hp}
                initial={{ scale: 1.4 }}
                animate={{ scale: 1 }}
                transition={{ duration: 0.3, type: "spring", stiffness: 300 }}
                className={`inline-block font-bold ${
                  stats.hp < 20 ? "text-red-400" : stats.hp < 40 ? "text-amber-400" : "text-foreground/90"
                }`}
              >
                {stats.hp}
              </motion.span>
              <span className="text-muted-foreground">/{stats.maxHp}</span>
            </span>
            <AnimatePresence>
              {lastHpDelta !== null && (
                <motion.span
                  key={`badge-${lastHpDelta}-${stats.hp}`}
                  initial={{ opacity: 0, scale: 0.7, x: -4 }}
                  animate={{ opacity: 1, scale: 1, x: 0 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ duration: 0.2 }}
                  className={`text-[11px] font-black px-1.5 py-0.5 rounded-full border ${
                    lastHpDelta < 0
                      ? "text-red-200 bg-red-900/60 border-red-700/50"
                      : "text-green-300 bg-green-900/50 border-green-700/50"
                  }`}
                >
                  {lastHpDelta < 0 ? `▼ ${Math.abs(lastHpDelta)}` : `▲ ${lastHpDelta}`}
                </motion.span>
              )}
            </AnimatePresence>
          </div>
          <div className="flex-1">
            <HpBar hp={stats.hp} maxHp={stats.maxHp} />
          </div>
        </div>

        {/* Other stats */}
        <div className="grid grid-cols-4 gap-2">
          {statRows.map(({ key, short, icon: Icon, value, change, worldChange }) => (
            <div key={key} className="relative space-y-1">
              <div className="flex items-center gap-1">
                <Icon className="w-2.5 h-2.5 text-muted-foreground" />
                <span className="text-[10px] text-muted-foreground">{short}</span>
                <motion.span
                  key={`${key}-${value}`}
                  initial={{ scale: 1.3, color: "hsl(43 90% 55%)" }}
                  animate={{ scale: 1, color: "hsl(43 25% 85%)" }}
                  transition={{ duration: 0.3 }}
                  className="text-[10px] font-semibold ml-auto tabular-nums"
                >
                  {value}
                </motion.span>
              </div>
              <div className="relative">
                <StatPips value={value} />
                <AnimatePresence>
                  {!!change && (
                    <motion.span
                      key={`${key}-delta-${change}`}
                      initial={{ opacity: 1, y: 0 }}
                      animate={{ opacity: 0, y: -14 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 1.0, ease: "easeOut" }}
                      className={`absolute -top-3 right-0 text-[10px] font-black ${
                        change > 0 ? "text-green-400" : "text-red-400"
                      }`}
                    >
                      {change > 0 ? `+${change}` : change}
                    </motion.span>
                  )}
                  {!!worldChange && !change && (
                    <motion.span
                      key={`${key}-world-${worldChange}`}
                      initial={{ opacity: 1, y: 0 }}
                      animate={{ opacity: 0, y: -14 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 1.4, ease: "easeOut", delay: 0.3 }}
                      className={`absolute -top-3 right-0 text-[10px] font-black ${
                        worldChange > 0 ? "text-amber-400" : "text-orange-400"
                      }`}
                    >
                      {worldChange > 0 ? `★+${worldChange}` : `★${worldChange}`}
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

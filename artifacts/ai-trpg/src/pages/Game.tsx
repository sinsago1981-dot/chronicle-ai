import {
  useState, useEffect, useRef, useCallback, useMemo, memo,
} from "react";
import { useParams, useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  Loader2, ArrowLeft, BookOpen, Trophy, Skull, Dices, User, Zap, Key, ShoppingBag, ScrollText, ChevronDown, ChevronUp,
} from "lucide-react";
import type { StoryResponse, Stats, StatChanges, RollResult, DiceOutcome, Skill, Enemy, EnemyChanges, Item, KeyItemChoice, SkillChoice } from "@/types";
import { motion, AnimatePresence } from "framer-motion";
import { useLang } from "@/lib/i18n";
import { LangToggle } from "@/components/LangToggle";
import { StatsPanel } from "@/components/StatsPanel";
import { EnemyPanel } from "@/components/EnemyPanel";
import { SkillsBar } from "@/components/SkillsBar";
import { ItemsPanel } from "@/components/ItemsPanel";
import { CombatPanel } from "@/components/CombatPanel";

// ─── Types ────────────────────────────────────────────────────────────────────

type StoryBeat = {
  id: number;
  narration: string;
  sentences: string[];
  choices: string[];
  chosenIndex?: number;
  chosenText?: string;
  roll?: RollResult;
  statChanges?: StatChanges;
  isEnding?: boolean;
};

type DicePhase = "idle" | "ready" | "rolling";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?。\n]+[.!?。]*\n?/g);
  if (!parts) return [text];
  const clean = parts.map(s => s.trim()).filter(Boolean);
  return clean.length ? clean : [text];
}

// ─── Dice threshold helpers (mirrors server-side detectStat logic) ─────────

const STRENGTH_KW  = ["fight","attack","strike","force","push","break","charge","combat","hit","bash","block","smash","punch","kick","rush","assault","wrestle","overpower","brawl","싸우","공격","강제","밀어","부수","돌격","전투","막아","방패","때려","강행","베어","찔러","쳐"];
const CUNNING_KW   = ["sneak","hide","steal","lie","deceive","trick","persuade","pick","unlock","shadow","escape","bluff","slip","conceal","distract","bribe","forge","infiltrate","숨어","훔쳐","속여","기만","설득","자물쇠","탈출","위장","침투","뇌물","분산","피해"];
const WILL_KW      = ["cast","magic","spell","resist","endure","focus","meditate","channel","banish","summon","enchant","curse","ritual","ward","sense","probe","mind","psychic","willpower","arcane","주문","마법","시전","저항","견뎌","집중","명상","소환","봉인","정신","의지","영적"];
const REPUTATION_KW = ["speak","negotiate","command","lead","inspire","threaten","appeal","rally","convince","authority","presence","reputation","name","fame","dignity","barter","demand","말해","협상","지휘","이끌","고무","위협","호소","권위","명성","존엄"];

function detectChoiceStat(choice: string, stats: Stats): { stat: keyof Omit<Stats, "hp" | "maxHp">; label: string } {
  const lo = choice.toLowerCase();
  const scores = {
    strength:   STRENGTH_KW.filter(k => lo.includes(k)).length,
    cunning:    CUNNING_KW.filter(k => lo.includes(k)).length,
    will:       WILL_KW.filter(k => lo.includes(k)).length,
    reputation: REPUTATION_KW.filter(k => lo.includes(k)).length,
  };
  const best = (["strength","cunning","will","reputation"] as const).reduce((a, b) => {
    if (scores[a] !== scores[b]) return scores[a] > scores[b] ? a : b;
    return stats[a] >= stats[b] ? a : b;
  });
  const labels: Record<string, string> = { strength: "STR", cunning: "CUN", will: "WIL", reputation: "REP" };
  return { stat: best, label: labels[best] };
}

function statMod(v: number): number { return Math.floor((v - 5) / 2); }

function diceThreshold(choice: string, stats: Stats, skillBonus: number): { label: string; modifier: number; needed: number; chance: number } {
  const { stat, label } = detectChoiceStat(choice, stats);
  const modifier = statMod(stats[stat]) + skillBonus;
  const needed   = Math.max(1, Math.min(20, 14 - modifier));
  const chance   = Math.round(Math.max(0, Math.min(100, ((20 - needed + 1) / 20) * 100)));
  return { label, modifier, needed, chance };
}

// ─── Typewriter ───────────────────────────────────────────────────────────────

const TYPING_SPEED_MS = 26;

const Typewriter = memo(function Typewriter({
  text, skip, onComplete,
}: { text: string; skip: boolean; onComplete: () => void }) {
  const [displayed, setDisplayed] = useState("");
  const idxRef      = useRef(0);
  const doneRef     = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cbRef       = useRef(onComplete);
  cbRef.current     = onComplete;

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setDisplayed("");
    idxRef.current  = 0;
    doneRef.current = false;

    intervalRef.current = setInterval(() => {
      if (doneRef.current) { clearInterval(intervalRef.current!); return; }
      idxRef.current++;
      setDisplayed(text.slice(0, idxRef.current));
      if (idxRef.current >= text.length) {
        clearInterval(intervalRef.current!);
        doneRef.current = true;
        cbRef.current();
      }
    }, TYPING_SPEED_MS);

    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [text]);

  useEffect(() => {
    if (skip && !doneRef.current) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      doneRef.current = true;
      setDisplayed(text);
      cbRef.current();
    }
  }, [skip, text]);

  const done = displayed.length >= text.length;
  return (
    <span>
      {displayed}
      {!done && <span className="inline-block w-0.5 h-4 bg-primary/70 ml-0.5 animate-pulse align-middle" />}
    </span>
  );
});

// ─── Dice ─────────────────────────────────────────────────────────────────────

const OUTCOME_STYLE: Record<DiceOutcome, { color: string; bg: string; border: string }> = {
  critical_failure: { color: "text-red-400",   bg: "bg-red-950/40",    border: "border-red-500/40"    },
  failure:          { color: "text-orange-400", bg: "bg-orange-950/30", border: "border-orange-500/30" },
  partial:          { color: "text-amber-400",  bg: "bg-amber-950/30",  border: "border-amber-500/30"  },
  success:          { color: "text-green-400",  bg: "bg-green-950/30",  border: "border-green-500/30"  },
  critical_success: { color: "text-yellow-300", bg: "bg-yellow-950/30", border: "border-yellow-400/50" },
};

const DiceRollCard = memo(function DiceRollCard({ roll }: { roll: RollResult }) {
  const { t } = useLang();
  const d            = t.dice;
  const style        = OUTCOME_STYLE[roll.outcome];
  const statLabel    = (d.statNames as Record<string, string>)[roll.stat] ?? roll.stat.toUpperCase();
  const outcomeLabel = (d.outcomes  as Record<string, string>)[roll.outcome] ?? roll.outcome;
  const modSign      = roll.modifier >= 0 ? `+${roll.modifier}` : `${roll.modifier}`;

  return (
    <motion.div
      initial={{ opacity: 0, y: -6, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${style.bg} ${style.border}`}
    >
      <motion.div initial={{ rotate: -180, scale: 0.5 }} animate={{ rotate: 0, scale: 1 }}
        transition={{ duration: 0.5, type: "spring", stiffness: 250 }}>
        <Dices className={`w-5 h-5 shrink-0 ${style.color}`} />
      </motion.div>
      <div className="flex items-center gap-1.5 text-sm font-mono text-muted-foreground/70">
        <span className="text-foreground/50 text-xs">d20</span>
        <motion.span initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.1, type: "spring", stiffness: 300 }}
          className="text-foreground font-bold text-lg">{roll.raw}</motion.span>
        <span className="text-muted-foreground/40 text-xs">·</span>
        <span className="text-xs">{statLabel}</span>
        <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}
          className={`text-xs font-bold ${roll.modifier >= 0 ? "text-green-400/90" : "text-red-400/90"}`}>{modSign}</motion.span>
        <span className="text-muted-foreground/40 text-xs">=</span>
        <motion.span initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.28, type: "spring", stiffness: 300 }}
          className={`font-black text-xl ${style.color}`}>{roll.total}</motion.span>
      </div>
      <motion.span initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.35 }}
        className={`ml-auto text-xs font-bold tracking-wide ${style.color}`}>{outcomeLabel}</motion.span>
    </motion.div>
  );
});

const DiceAnimation = memo(function DiceAnimation() {
  const [face, setFace] = useState(1);
  useEffect(() => {
    let speed = 60;
    let count = 0;
    const max = 28;
    const run = () => {
      setFace(Math.floor(Math.random() * 20) + 1);
      count++;
      speed = Math.min(speed + count * 3, 250);
      if (count < max) setTimeout(run, speed);
    };
    run();
  }, []);

  return (
    <motion.div
      animate={{ rotate: [0, -15, 15, -10, 10, 0], scale: [1, 1.15, 1.05, 1.1, 1] }}
      transition={{ duration: 0.6, ease: "easeInOut", repeat: Infinity }}
      className="flex items-center justify-center w-16 h-16 rounded-xl border-2 border-primary/60 bg-primary/10 text-primary font-black text-2xl select-none"
    >
      {face}
    </motion.div>
  );
});

// ─── Past beat ────────────────────────────────────────────────────────────────

const PastBeat = memo(function PastBeat({
  beat, beatIdx, choseLabel,
}: { beat: StoryBeat; beatIdx: number; choseLabel: string }) {
  return (
    <div className="space-y-4 opacity-65">
      {beat.roll && beatIdx > 0 && <DiceRollCard roll={beat.roll} />}
      <div className="space-y-2.5">
        {beat.sentences.map((s, i) => (
          <p key={i} className="text-foreground/70 leading-relaxed font-serif text-sm">{s}</p>
        ))}
      </div>
      {beat.chosenText && (
        <div className="pl-4 border-l-2 border-primary/20">
          <p className="text-muted-foreground/60 text-xs italic">
            {choseLabel} <span className="text-foreground/50">{beat.chosenText}</span>
          </p>
        </div>
      )}
    </div>
  );
});

// ─── Game ─────────────────────────────────────────────────────────────────────

export default function Game() {
  const { id }      = useParams<{ id: string }>();
  const sessionId   = parseInt(id);
  const [, setLocation] = useLocation();
  const { lang, t } = useLang();
  const bottomRef   = useRef<HTMLDivElement>(null);
  const beatIdRef   = useRef(0);
  const clearTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [beats,          setBeats]         = useState<StoryBeat[]>([]);
  const [isEnded,        setIsEnded]        = useState(false);
  const [revealedCount,  setRevealedCount]  = useState(1);
  const [choicesVisible, setChoicesVisible] = useState(false);
  const [stats,          setStats]          = useState<Stats | null>(null);
  const [latestChanges,  setLatestChanges]  = useState<StatChanges>({});
  const [isTyping,       setIsTyping]       = useState(false);
  const [skipTyping,     setSkipTyping]     = useState(false);
  const [playerMeta,     setPlayerMeta]     = useState<{ name: string; characterClass: string } | null>(null);

  // Skills & enemy
  const [skills,          setSkills]         = useState<Skill[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [enemy,           setEnemy]          = useState<Enemy | null>(null);
  const [enemyChanges,    setEnemyChanges]   = useState<EnemyChanges>({});
  const [inCombat,        setInCombat]       = useState(false);

  // Inventory
  const [inventory,     setInventory]     = useState<Item[]>([]);
  const [newItemIds,    setNewItemIds]     = useState<Set<string>>(new Set());

  // Combat
  const [lastCombatLog, setLastCombatLog] = useState<string[]>([]);

  // World events chronicle
  const [worldEvents,           setWorldEvents]          = useState<string[]>([]);
  const [chronicleOpen,         setChronicleOpen]        = useState(false);

  // World consequence notification
  const [worldConsequences,     setWorldConsequences]    = useState<StatChanges>({});
  const [worldConsequenceDesc,  setWorldConsequenceDesc] = useState<string>("");
  const [showWorldEffect,       setShowWorldEffect]      = useState(false);
  const worldEffectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Key item now-or-never choices
  const [keyItemChoices,        setKeyItemChoices]       = useState<KeyItemChoice[]>([]);
  const [expiredItems,          setExpiredItems]         = useState<string[]>([]);

  // Skill-based narrative choices
  const [skillChoices,          setSkillChoices]         = useState<SkillChoice[]>([]);
  const expiredItemTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Dice phase
  const [pendingChoice, setPendingChoice] = useState<{ index: number; text: string } | null>(null);
  const [dicePhase,     setDicePhase]     = useState<DicePhase>("idle");

  const currentBeat      = beats[beats.length - 1];
  const currentSentences = useMemo(() => currentBeat?.sentences ?? [], [currentBeat]);
  const allRevealed      = revealedCount >= currentSentences.length;
  const isDead           = stats !== null && stats.hp <= 0;

  const { data: gameData, isLoading } = useQuery({
    queryKey: [`/api/game/${sessionId}`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/game/${sessionId}`);
      return res.json();
    },
    enabled: !!sessionId,
  });

  useEffect(() => {
    if (!gameData || beats.length > 0) return;
    if (gameData.stats)      setStats(gameData.stats);
    if (gameData.inventory)  setInventory(gameData.inventory);
    if (gameData.playerMeta) {
      setPlayerMeta(gameData.playerMeta);
      setSkills(gameData.playerMeta.skills ?? []);
    }
    if (gameData.enemy) {
      setEnemy(gameData.enemy);
      setInCombat(true);   // restore combat state on reload
    }
    if (Array.isArray(gameData.worldEvents)) setWorldEvents(gameData.worldEvents);
    if (gameData.entries?.length > 0) {
      const last = [...gameData.entries].reverse().find((e: any) => e.entryType === "narration");
      if (last) {
        const data = JSON.parse(last.content);
        setBeats([{
          id: beatIdRef.current++,
          narration: data.narration,
          sentences: splitSentences(data.narration),
          choices: data.choices || [],
          isEnding: data.isEnding,
        }]);
        setRevealedCount(1);
        setIsTyping(true);
        if (data.isEnding) setIsEnded(true);
        if (data.inCombat && data.enemy) { setEnemy(data.enemy); setInCombat(true); setLastCombatLog([]); }
      }
    }
  }, [gameData]);

  const scheduleChangeClear = useCallback(() => {
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => { setLatestChanges({}); setEnemyChanges({}); }, 3000);
  }, []);

  const choiceMutation = useMutation({
    mutationFn: async ({ choiceIndex, choiceText, skillId, keyItemId }: { choiceIndex: number; choiceText: string; skillId?: string; keyItemId?: string }) => {
      const res = await apiRequest("POST", `/api/game/${sessionId}/choice`, { choiceIndex, choiceText, lang, skillId, keyItemId });
      return res.json() as Promise<StoryResponse>;
    },
    onSuccess: (data, variables) => {
      if (data.stats) {
        setLatestChanges(data.statChanges ?? {});
        setStats(data.stats);
      }
      if (data.skills) setSkills(data.skills);

      // Update inventory
      if (data.inventory) {
        setInventory(data.inventory);
        if (data.itemsGained && data.itemsGained.length > 0) {
          const ids = new Set(data.itemsGained.map((i: Item) => i.id));
          setNewItemIds(ids);
          setTimeout(() => setNewItemIds(new Set()), 4000);
        }
      }

      // Update enemy
      if (data.inCombat && data.enemy) {
        setEnemy(data.enemy);
        setInCombat(true);
        setEnemyChanges(data.enemyChanges ?? {});
        setLastCombatLog([]);
      } else {
        setEnemy(null);
        setInCombat(false);
        setEnemyChanges({});
      }

      scheduleChangeClear();

      // Update world chronicle
      if (Array.isArray(data.worldEvents) && data.worldEvents.length > 0) {
        setWorldEvents(data.worldEvents);
      }

      // Show world consequence notification
      const wc = data.worldConsequences ?? {};
      const wcHas = Object.values(wc).some((v): v is number => typeof v === "number" && v !== 0);
      if (wcHas) {
        setWorldConsequences(wc);
        setWorldConsequenceDesc(data.worldConsequenceDesc ?? "");
        setShowWorldEffect(true);
        if (worldEffectTimer.current) clearTimeout(worldEffectTimer.current);
        worldEffectTimer.current = setTimeout(() => setShowWorldEffect(false), 7000);
      }

      setBeats(prev => {
        const updated = prev.map((b, i) =>
          i === prev.length - 1
            ? { ...b, chosenIndex: variables.choiceIndex, chosenText: variables.choiceText }
            : b
        );
        return [...updated, {
          id: beatIdRef.current++,
          narration: data.narration,
          sentences: splitSentences(data.narration),
          choices: data.choices || [],
          roll: data.roll,
          statChanges: data.statChanges,
          isEnding: data.isEnding,
        }];
      });
      setRevealedCount(1);
      setChoicesVisible(false);
      setPendingChoice(null);
      setDicePhase("idle");
      setSelectedSkillId(null);
      setIsTyping(true);
      setSkipTyping(false);
      if (data.isEnding) setIsEnded(true);

      // Key item choices and skill choices for next turn
      setKeyItemChoices(data.keyItemChoices ?? []);
      setSkillChoices(data.skillChoices ?? []);

      // Show expired key item notification
      if (data.expiredKeyItemNames && data.expiredKeyItemNames.length > 0) {
        setExpiredItems(data.expiredKeyItemNames);
        if (expiredItemTimer.current) clearTimeout(expiredItemTimer.current);
        expiredItemTimer.current = setTimeout(() => setExpiredItems([]), 5000);
      }
    },
    onError: () => {
      setPendingChoice(null);
      setDicePhase("idle");
    },
  });

  // ── Item mutations ────────────────────────────────────────────────────────
  const useItemMutation = useMutation({
    mutationFn: async (itemId: string) => {
      const res = await apiRequest("POST", `/api/game/${sessionId}/use-item`, { itemId });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.stats)     setStats(data.stats);
      if (data.inventory) setInventory(data.inventory);
    },
  });

  const equipItemMutation = useMutation({
    mutationFn: async (itemId: string) => {
      const res = await apiRequest("POST", `/api/game/${sessionId}/equip-item`, { itemId });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.stats)     setStats(data.stats);
      if (data.inventory) setInventory(data.inventory);
    },
  });

  const useKeyItemMutation = useMutation({
    mutationFn: async (itemId: string) => {
      const res = await apiRequest("POST", `/api/game/${sessionId}/use-key-item`, { itemId, lang });
      return res.json() as Promise<StoryResponse>;
    },
    onSuccess: (data, itemId) => {
      if (data.stats)     setStats(data.stats);
      if (data.inventory) setInventory(data.inventory);
      if (data.inCombat && data.enemy) { setEnemy(data.enemy); setInCombat(true); }
      else { setEnemy(null); setInCombat(false); }
      setBeats(prev => {
        // Mark previous beat as "chosen" with the key item label
        const updated = prev.map((b, i) =>
          i === prev.length - 1
            ? { ...b, chosenText: `[${lang === "ko" ? "핵심 아이템 사용" : "Key Item Used"}]` }
            : b
        );
        return [...updated, {
          id: beatIdRef.current++,
          narration: data.narration,
          sentences: splitSentences(data.narration),
          choices: data.choices || [],
          isEnding: data.isEnding,
        }];
      });
      setRevealedCount(1);
      setChoicesVisible(false);
      setIsTyping(true);
      setSkipTyping(false);
      if (data.isEnding) setIsEnded(true);
    },
  });

  const combatActionMutation = useMutation({
    mutationFn: async ({ action, skillId, itemId }: { action: string; skillId?: string; itemId?: string }) => {
      const res = await apiRequest("POST", `/api/game/${sessionId}/combat-action`, { action, skillId, itemId, lang });
      return res.json() as Promise<StoryResponse>;
    },
    onSuccess: (data) => {
      if (data.stats) {
        setStats(data.stats);
        setLatestChanges(data.statChanges ?? {});
      }
      if (data.skills) setSkills(data.skills);
      if (data.inventory) {
        setInventory(data.inventory);
        if (data.itemsGained && data.itemsGained.length > 0) {
          const ids = new Set(data.itemsGained.map((i: Item) => i.id));
          setNewItemIds(ids);
          setTimeout(() => setNewItemIds(new Set()), 4000);
        }
      }

      // Save combat log for display
      setLastCombatLog(data.combatResult?.combatLog ?? []);

      // Update enemy
      if (data.inCombat && data.enemy) {
        setEnemy(data.enemy);
        setInCombat(true);
        setEnemyChanges({ hp: -(data.combatResult?.playerDamage ?? 0) });
      } else {
        setEnemy(null);
        setInCombat(false);
        setEnemyChanges({});
      }

      scheduleChangeClear();

      // Update world chronicle from combat victory/flee responses
      if (Array.isArray(data.worldEvents) && data.worldEvents.length > 0) {
        setWorldEvents(data.worldEvents);
      }

      // Add new beat
      setBeats(prev => {
        const updated = prev.map((b, i) =>
          i === prev.length - 1
            ? { ...b, chosenText: `[${lang === "ko" ? "전투 행동" : "Combat Action"}]` }
            : b
        );
        return [...updated, {
          id: beatIdRef.current++,
          narration: data.narration,
          sentences: splitSentences(data.narration),
          choices: data.choices || [],
          isEnding: data.isEnding,
        }];
      });
      setRevealedCount(1);
      setChoicesVisible(false);
      setIsTyping(true);
      setSkipTyping(false);
      if (data.isEnding) setIsEnded(true);
    },
    onError: () => {
      // stay in combat panel on error
    },
  });

  const anyMutationPending = choiceMutation.isPending || useKeyItemMutation.isPending || combatActionMutation.isPending;

  const selectChoice = useCallback((index: number, text: string) => {
    if (anyMutationPending) return;
    setPendingChoice({ index, text });
    setDicePhase("ready");
  }, [anyMutationPending]);

  const rollDice = useCallback(() => {
    if (!pendingChoice || dicePhase !== "ready") return;
    setDicePhase("rolling");
    choiceMutation.mutate({
      choiceIndex: pendingChoice.index,
      choiceText: pendingChoice.text,
      skillId: selectedSkillId ?? undefined,
    });
  }, [pendingChoice, dicePhase, choiceMutation, selectedSkillId]);

  const cancelChoice = useCallback(() => {
    setPendingChoice(null);
    setDicePhase("idle");
  }, []);

  const handleTypingComplete = useCallback(() => {
    setIsTyping(false);
    setSkipTyping(false);
  }, []);

  const advanceSentence = useCallback(() => {
    if (anyMutationPending || dicePhase !== "idle") return;
    if (isTyping)     { setSkipTyping(true); return; }
    if (!allRevealed) {
      setRevealedCount(c => Math.min(c + 1, currentSentences.length));
      setIsTyping(true);
      setSkipTyping(false);
      return;
    }
    if (!choicesVisible && !currentBeat?.isEnding && !currentBeat?.chosenText) {
      setChoicesVisible(true);
    }
  }, [isTyping, allRevealed, choicesVisible, currentBeat, currentSentences.length, anyMutationPending, dicePhase]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [revealedCount, choicesVisible, beats.length, anyMutationPending, isTyping, dicePhase]);

  useEffect(() => () => { if (clearTimer.current) clearTimeout(clearTimer.current); }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-4">
          <Loader2 className="w-10 h-10 text-primary animate-spin mx-auto" />
          <p className="text-muted-foreground animate-pulse">{t.loadingStory}</p>
        </div>
      </div>
    );
  }

  const pastBeats  = beats.slice(0, -1);
  const activeBeat = beats[beats.length - 1];
  const turnCount  = beats.length;

  // Skill lookup for dice panel display
  const activeSkill = selectedSkillId ? skills.find(s => s.id === selectedSkillId) : null;

  return (
    <div className="min-h-screen flex flex-col select-none bg-background" onClick={advanceSentence}>

      {/* ── Header ────────────────────────────────────────────────── */}
      <header
        className="sticky top-0 z-10 border-b border-border/50 bg-background/95 backdrop-blur-sm"
        onClick={e => e.stopPropagation()}
      >
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between gap-2">
          <button
            onClick={() => setLocation("/")}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors text-sm shrink-0"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="hidden sm:inline">{t.newChronicle}</span>
          </button>

          <div className="flex flex-col items-center min-w-0">
            {playerMeta && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <User className="w-3 h-3" />
                <span className="font-medium text-foreground/80 truncate max-w-[120px]">
                  {playerMeta.name || "—"}
                </span>
                <span className="text-muted-foreground/50">·</span>
                <span>{playerMeta.characterClass}</span>
              </div>
            )}
            <div className="text-[10px] text-muted-foreground/50">
              {isEnded ? t.chronicleComplete : `${t.turnLabel} ${turnCount}`}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {inventory.length > 0 && (
              <div className="relative flex items-center">
                <ShoppingBag className="w-4 h-4 text-muted-foreground/60" />
                <span className="absolute -top-1.5 -right-1.5 text-[9px] font-bold bg-primary/80 text-background rounded-full w-3.5 h-3.5 flex items-center justify-center">
                  {inventory.reduce((s, i) => s + (i.quantity ?? 1), 0)}
                </span>
              </div>
            )}
            <LangToggle />
          </div>
        </div>
      </header>

      {/* ── Player stats panel (sticky) ────────────────────────────── */}
      {stats && <StatsPanel stats={stats} latestChanges={latestChanges} worldEffect={showWorldEffect ? worldConsequences : {}} />}

      {/* ── Enemy panel (sticky, below stats) ─────────────────────── */}
      <div className="sticky top-[calc(56px+6rem)] z-[8]" onClick={e => e.stopPropagation()}>
        <AnimatePresence>
          {inCombat && enemy && (
            <EnemyPanel key="enemy" enemy={enemy} changes={enemyChanges} />
          )}
        </AnimatePresence>
      </div>

      {/* ── New item toast ─────────────────────────────────────────── */}
      <AnimatePresence>
        {newItemIds.size > 0 && (
          <motion.div
            key="item-toast"
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            transition={{ duration: 0.3 }}
            className="fixed top-16 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-1"
            onClick={e => e.stopPropagation()}
          >
            {inventory.filter(i => newItemIds.has(i.id)).map(item => (
              <div key={item.id} className="flex items-center gap-2 px-4 py-2 rounded-full bg-primary/90 text-background text-sm font-semibold shadow-lg">
                <span>{item.icon || "📦"}</span>
                <span>{lang === "ko" ? "획득: " : "Obtained: "}{lang === "ko" ? item.nameKo : item.name}</span>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Scrollable story ───────────────────────────────────────── */}
      <div className="flex-1 max-w-3xl w-full mx-auto px-4 py-8 space-y-8">

        {/* Past beats */}
        {pastBeats.map((beat, idx) => (
          <PastBeat key={beat.id} beat={beat} beatIdx={idx} choseLabel={t.choseLabel} />
        ))}

        {/* Separator */}
        {pastBeats.length > 0 && (
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-border/30" />
            <div className="w-1.5 h-1.5 rounded-full bg-primary/40" />
            <div className="flex-1 h-px bg-border/30" />
          </div>
        )}

        {/* ── World consequence notification ── */}
        <AnimatePresence>
          {showWorldEffect && worldConsequenceDesc && (
            <motion.div
              key="world-effect-banner"
              initial={{ opacity: 0, y: -8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.97 }}
              transition={{ duration: 0.3 }}
              className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg border border-amber-500/25 bg-amber-500/5"
            >
              <span className="text-amber-400 text-xs mt-px shrink-0">★</span>
              <div className="space-y-1 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-semibold text-amber-500/80 uppercase tracking-wider">
                    {lang === "ko" ? "세계 영향" : "World Effect"}
                  </span>
                  <span className="flex gap-1">
                    {Object.entries(worldConsequences)
                      .filter(([, v]) => typeof v === "number" && v !== 0)
                      .map(([k, v]) => (
                        <span key={k} className={`text-[10px] font-black px-1 rounded ${(v as number) > 0 ? "text-amber-300 bg-amber-900/40" : "text-orange-300 bg-orange-900/40"}`}>
                          {k === "hp" ? "HP" : k === "strength" ? (lang === "ko" ? "힘" : "STR") : k === "cunning" ? (lang === "ko" ? "교활" : "CUN") : k === "will" ? (lang === "ko" ? "의지" : "WIL") : (lang === "ko" ? "명성" : "REP")}
                          {(v as number) > 0 ? `+${v}` : v}
                        </span>
                      ))
                    }
                  </span>
                </div>
                <p className="text-xs text-amber-100/60 leading-relaxed">{worldConsequenceDesc}</p>
              </div>
              <button className="text-amber-500/30 hover:text-amber-500/60 text-xs" onClick={() => setShowWorldEffect(false)}>✕</button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Expired key item notification ── */}
        <AnimatePresence>
          {expiredItems.length > 0 && (
            <motion.div
              key="expired-banner"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.25 }}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-red-500/20 bg-red-950/10"
            >
              <span className="text-red-400/60 text-xs shrink-0">✕</span>
              <p className="text-xs text-red-300/50">
                {lang === "ko"
                  ? `기회를 놓쳤습니다. ${expiredItems.join(", ")}이(가) 영구히 소멸되었습니다.`
                  : `Opportunity missed. ${expiredItems.join(", ")} ${expiredItems.length > 1 ? "have" : "has"} been permanently destroyed.`
                }
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Active beat */}
        {activeBeat && (
          <div className="space-y-4">
            {activeBeat.roll && pastBeats.length > 0 && <DiceRollCard roll={activeBeat.roll} />}

            <div className="space-y-3">
              {currentSentences.slice(0, revealedCount).map((sentence, i) => (
                <p key={i} className="text-foreground/95 leading-relaxed font-serif">
                  {i === revealedCount - 1 && isTyping ? (
                    <Typewriter text={sentence} skip={skipTyping} onComplete={handleTypingComplete} />
                  ) : sentence}
                </p>
              ))}
            </div>

            {/* Tap hints */}
            {!choiceMutation.isPending && dicePhase === "idle" && (
              <AnimatePresence>
                {isTyping && (
                  <motion.p key="typing-hint" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="text-xs text-muted-foreground/40 italic">{t.tapToContinue}</motion.p>
                )}
                {!isTyping && allRevealed && !choicesVisible && !activeBeat.isEnding && !activeBeat.chosenText && (
                  <motion.p key="choice-hint" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="text-xs text-muted-foreground/40 italic">{t.tapForChoices}</motion.p>
                )}
              </AnimatePresence>
            )}

            {/* ── Choice list ── */}
            <AnimatePresence>
              {choicesVisible && !activeBeat.isEnding && !activeBeat.chosenText && dicePhase === "idle" && (
                <motion.div
                  key="choices"
                  initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }} transition={{ duration: 0.25 }}
                  className="space-y-4 pt-2"
                  onClick={e => e.stopPropagation()}
                >
                  {/* ─── COMBAT MODE: CombatPanel replaces normal choices ─── */}
                  {inCombat && enemy && stats ? (
                    <CombatPanel
                      stats={stats}
                      enemy={enemy}
                      skills={skills}
                      inventory={inventory}
                      isPending={combatActionMutation.isPending}
                      lastCombatLog={lastCombatLog}
                      onAction={(action, skillId, itemId) =>
                        combatActionMutation.mutate({ action, skillId, itemId })
                      }
                    />
                  ) : (
                    <>
                      <p className="text-sm text-muted-foreground/70 font-medium">{t.choicePrompt}</p>
                      <div className="space-y-2">
                        {activeBeat.choices.map((choice, idx) => {
                          const activeSkillBonus = stats && selectedSkillId
                            ? (skills.find(s => s.id === selectedSkillId)?.bonusValue ?? 0) : 0;
                          const threshold = stats ? diceThreshold(choice, stats, activeSkillBonus) : null;
                          const chanceColor = threshold
                            ? threshold.chance >= 65 ? "text-green-400/80"
                              : threshold.chance >= 35 ? "text-yellow-400/80"
                              : "text-red-400/80"
                            : "";
                          return (
                            <Button
                              key={idx}
                              variant="outline"
                              className="w-full text-left h-auto py-2 px-4 justify-start whitespace-normal hover:border-primary/50 hover:bg-primary/5 transition-all flex-col items-start gap-0.5"
                              onClick={() => selectChoice(idx, choice)}
                            >
                              <div className="flex items-start gap-2 w-full">
                                <span className="text-primary/60 mt-0.5 shrink-0 font-mono text-xs">{idx + 1}.</span>
                                <span className="text-sm">{choice}</span>
                              </div>
                              {threshold && (
                                <div className="flex items-center gap-1.5 pl-4 mt-0.5">
                                  <span className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-wider">{threshold.label}</span>
                                  <span className="text-[10px] text-muted-foreground/50">{threshold.modifier >= 0 ? `+${threshold.modifier}` : threshold.modifier}</span>
                                  <span className="text-[10px] text-muted-foreground/40">·</span>
                                  <span className="text-[10px] font-semibold text-muted-foreground/70">d20 ≥ {threshold.needed}</span>
                                  <span className="text-[10px] text-muted-foreground/40">·</span>
                                  <span className={`text-[10px] font-bold ${chanceColor}`}>{threshold.chance}%</span>
                                </div>
                              )}
                            </Button>
                          );
                        })}
                      </div>

                      {/* ─── Skill-activated narrative choices ─── */}
                      {skillChoices.length > 0 && (
                        <motion.div
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="space-y-2 pt-1"
                        >
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-px bg-violet-500/20" />
                            <div className="flex items-center gap-1.5">
                              <Zap className="w-2.5 h-2.5 text-violet-400/70" />
                              <span className="text-[9px] font-black text-violet-400/70 uppercase tracking-widest">
                                {lang === "ko" ? "스킬 행동" : "SKILL ACTION"}
                              </span>
                            </div>
                            <div className="flex-1 h-px bg-violet-500/20" />
                          </div>
                          {skillChoices.map(sc => {
                            const skill = skills.find(s => s.id === sc.skillId);
                            if (!skill) return null;
                            const bonus = skill.bonusValue;
                            return (
                              <Button
                                key={sc.skillId}
                                variant="outline"
                                disabled={choiceMutation.isPending}
                                className="w-full text-left h-auto py-2.5 px-4 justify-start border-violet-500/40 hover:border-violet-400/70 hover:bg-violet-950/20 transition-all group flex-col items-start gap-1"
                                style={{ borderStyle: "dashed" }}
                                onClick={() => {
                                  setSkillChoices([]);
                                  selectChoice(activeBeat!.choices.length + keyItemChoices.length, sc.choiceText);
                                  setSelectedSkillId(sc.skillId);
                                }}
                              >
                                <div className="flex items-center gap-2 w-full">
                                  <Zap className="w-3 h-3 text-violet-400/70 shrink-0 mt-0.5" />
                                  <span className="text-sm text-foreground/90">{sc.choiceText}</span>
                                </div>
                                <div className="flex items-center gap-1.5 pl-5">
                                  <span className="text-[10px] font-bold text-violet-400/60 uppercase tracking-wider">
                                    {lang === "ko" ? skill.nameKo : skill.name}
                                  </span>
                                  {bonus > 0 && (
                                    <>
                                      <span className="text-[10px] text-violet-400/40">·</span>
                                      <span className="text-[10px] font-semibold text-violet-300/70">+{bonus} 보너스</span>
                                    </>
                                  )}
                                  {skill.cooldown > 0 && (
                                    <>
                                      <span className="text-[10px] text-violet-400/40">·</span>
                                      <span className="text-[10px] text-violet-400/50">
                                        {lang === "ko" ? `재사용 ${skill.cooldown}턴` : `${skill.cooldown}t cooldown`}
                                      </span>
                                    </>
                                  )}
                                </div>
                              </Button>
                            );
                          })}
                        </motion.div>
                      )}

                      {/* ─── Key item NOW OR NEVER choices (AI-activated) ─── */}
                      {keyItemChoices.length > 0 && (
                        <motion.div
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="space-y-2 pt-1"
                        >
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-px bg-amber-500/20" />
                            <div className="flex items-center gap-1.5">
                              <span className="text-[9px] font-black text-amber-500/70 uppercase tracking-widest animate-pulse">
                                {lang === "ko" ? "⚠ 지금이 아니면 사라집니다" : "⚠ NOW OR NEVER"}
                              </span>
                            </div>
                            <div className="flex-1 h-px bg-amber-500/20" />
                          </div>
                          {keyItemChoices.map(kic => {
                            const item = inventory.find(i => i.id === kic.itemId);
                            return (
                              <Button
                                key={kic.itemId}
                                variant="outline"
                                disabled={choiceMutation.isPending}
                                className="w-full text-left h-auto py-2.5 px-4 justify-start border-amber-500/40 hover:border-amber-400/70 hover:bg-amber-950/20 transition-all group"
                                style={{ borderStyle: "dashed" }}
                                onClick={() => {
                                  setKeyItemChoices([]);
                                  choiceMutation.mutate({
                                    choiceIndex: activeBeat!.choices.length,
                                    choiceText: kic.choiceText,
                                    keyItemId: kic.itemId,
                                  });
                                }}
                              >
                                <div className="space-y-1 w-full">
                                  <div className="flex items-center gap-2">
                                    <span className="text-amber-500/80">{item?.icon || "🗝️"}</span>
                                    <span className="text-xs font-bold text-amber-400/90 group-hover:text-amber-300">
                                      {lang === "ko" ? "핵심 아이템" : "Key Item"}
                                    </span>
                                    <Key className="w-3 h-3 text-amber-500/60 ml-auto" />
                                  </div>
                                  <p className="text-sm text-foreground/80 pl-1">{kic.choiceText}</p>
                                </div>
                              </Button>
                            );
                          })}
                        </motion.div>
                      )}

                      {/* Skills — only visible in combat or when skill choices are available */}
                      {skills.length > 0 && (inCombat || skillChoices.length > 0) && (
                        <div className="border-t border-border/30 pt-3" onClick={e => e.stopPropagation()}>
                          <SkillsBar
                            skills={skills}
                            selectedSkillId={selectedSkillId}
                            onSelect={inCombat || skillChoices.length > 0 ? setSelectedSkillId : () => {}}
                            disabled={!inCombat && skillChoices.length === 0}
                          />
                        </div>
                      )}

                      {/* Inventory panel */}
                      {inventory.length > 0 && (
                        <div className="border-t border-border/20 pt-3" onClick={e => e.stopPropagation()}>
                          <ItemsPanel
                            inventory={inventory}
                            onUse={useItemMutation.mutate}
                            onEquip={equipItemMutation.mutate}
                            isPending={useItemMutation.isPending || equipItemMutation.isPending}
                          />
                        </div>
                      )}

                      {/* Chronicle panel — world events */}
                      {worldEvents.length > 0 && (
                        <div className="border-t border-border/20 pt-3" onClick={e => e.stopPropagation()}>
                          <button
                            className="flex items-center gap-2 w-full text-left text-xs text-muted-foreground/70 hover:text-muted-foreground transition-colors mb-2"
                            onClick={() => setChronicleOpen(o => !o)}
                          >
                            <ScrollText className="w-3.5 h-3.5 text-amber-500/70" />
                            <span className="font-medium text-amber-500/80">
                              {lang === "ko" ? `연대기 (${worldEvents.length})` : `Chronicle (${worldEvents.length})`}
                            </span>
                            {chronicleOpen ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
                          </button>
                          <AnimatePresence>
                            {chronicleOpen && (
                              <motion.ul
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: "auto" }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={{ duration: 0.2 }}
                                className="space-y-1.5 overflow-hidden"
                              >
                                {worldEvents.map((event, idx) => (
                                  <li key={idx} className="flex items-start gap-2 text-xs text-muted-foreground/60">
                                    <span className="text-amber-500/40 shrink-0 mt-px">◆</span>
                                    <span className="leading-relaxed">{event}</span>
                                  </li>
                                ))}
                              </motion.ul>
                            )}
                          </AnimatePresence>
                        </div>
                      )}
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {/* ── Dice roll panel ── */}
            <AnimatePresence>
              {(dicePhase === "ready" || dicePhase === "rolling") && pendingChoice && (
                <motion.div
                  key="dice-panel"
                  initial={{ opacity: 0, y: 12, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ duration: 0.25 }}
                  className="space-y-4 pt-2"
                  onClick={e => e.stopPropagation()}
                >
                  {/* Selected choice */}
                  <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-primary/5 border border-primary/20">
                    <span className="text-primary/60 font-mono text-xs mt-0.5 shrink-0">
                      {pendingChoice.index + 1}.
                    </span>
                    <p className="text-sm text-foreground/90">{pendingChoice.text}</p>
                  </div>

                  {/* Active skill badge */}
                  {activeSkill && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/10 border border-primary/30"
                    >
                      <Zap className="w-3.5 h-3.5 text-primary shrink-0" />
                      <span className="text-xs font-semibold text-primary">
                        {lang === "ko" ? activeSkill.nameKo : activeSkill.name}
                      </span>
                      <span className="text-xs text-muted-foreground/60 ml-auto">
                        {activeSkill.statBonus.toUpperCase()} +{activeSkill.bonusValue}
                        {activeSkill.hpEffect ? ` · HP ${activeSkill.hpEffect > 0 ? "+" : ""}${activeSkill.hpEffect}` : ""}
                      </span>
                    </motion.div>
                  )}

                  {/* Dice */}
                  <div className="flex flex-col items-center gap-4 py-4">
                    {dicePhase === "rolling" ? (
                      <>
                        <DiceAnimation />
                        <p className="text-sm text-muted-foreground/60 animate-pulse">
                          {lang === "ko" ? "주사위를 굴리는 중..." : "Rolling the die..."}
                        </p>
                      </>
                    ) : (
                      <>
                        <motion.div
                          whileHover={{ scale: 1.05, rotate: 5 }}
                          whileTap={{ scale: 0.95, rotate: -5 }}
                          className="flex items-center justify-center w-16 h-16 rounded-xl border-2 border-primary/50 bg-primary/10 text-primary/70 cursor-pointer"
                          onClick={rollDice}
                        >
                          <Dices className="w-8 h-8" />
                        </motion.div>
                        <div className="flex items-center gap-3">
                          <Button onClick={rollDice} className="gap-2 px-6" size="lg">
                            <Dices className="w-4 h-4" />
                            {lang === "ko" ? "d20 굴리기!" : "Roll d20!"}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={cancelChoice} className="text-muted-foreground">
                            {lang === "ko" ? "취소" : "Cancel"}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground/50">
                          {lang === "ko"
                            ? "주사위를 굴려 행동의 결과를 결정하세요"
                            : "Roll to determine the outcome of your action"}
                        </p>
                      </>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Loading (no dice) */}
            {choiceMutation.isPending && dicePhase === "idle" && (
              <div className="flex items-center gap-2 text-muted-foreground/50 text-sm">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span className="animate-pulse">{t.loadingStory}</span>
              </div>
            )}

            {/* Ending */}
            {isEnded && allRevealed && (
              <motion.div
                initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.3 }}
                className="pt-6 space-y-4 text-center"
                onClick={e => e.stopPropagation()}
              >
                <div className="flex justify-center">
                  {isDead
                    ? <Skull className="w-10 h-10 text-red-400/70" />
                    : <Trophy className="w-10 h-10 text-primary/70" />}
                </div>
                <div>
                  <p className="font-serif text-lg font-medium">{isDead ? t.deathTitle : t.endingTitle}</p>
                  <p className="text-sm text-muted-foreground">{isDead ? t.deathSubtitle : t.endingSubtitle}</p>
                </div>
                <Button variant="outline" onClick={() => setLocation("/")}>
                  <BookOpen className="w-4 h-4 mr-2" />
                  {t.beginNewChronicle}
                </Button>
              </motion.div>
            )}
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

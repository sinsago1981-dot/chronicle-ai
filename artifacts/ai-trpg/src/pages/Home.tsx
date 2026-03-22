import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, ScrollText, Skull, AlertCircle, CheckCircle2, ChevronLeft, Lock } from "lucide-react";
import { useLang } from "@/lib/i18n";
import { LangToggle } from "@/components/LangToggle";
import { motion, AnimatePresence } from "framer-motion";
import type { Skill, SkillType } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────

type Archetype = "fighter" | "trickster" | "scholar" | "speaker";

type QuestionOption = {
  text: string;
  textKo: string;
  archetype: Archetype;
  bonus: { strength?: number; cunning?: number; will?: number; reputation?: number; hp?: number };
};

type Question = {
  text: string;
  textKo: string;
  options: QuestionOption[];
};

type ComputedStats = {
  hp: number; maxHp: number;
  strength: number; cunning: number; will: number; reputation: number;
};

// ─── Config ───────────────────────────────────────────────────────────────────

const GENRE_KEYS = ["fantasy", "dark fantasy", "sci-fi", "horror", "western"] as const;

const BASE_STATS: ComputedStats = { hp: 60, maxHp: 60, strength: 2, cunning: 2, will: 2, reputation: 2 };

const ARCHETYPE_CLASS: Record<Archetype, { en: string; ko: string; desc: string; descKo: string }> = {
  fighter:  { en: "Warrior",  ko: "전사",     desc: "Your body is your weapon. You endure, push forward, and outlast.", descKo: "몸이 무기다. 버티고, 밀어붙이고, 마지막까지 살아남는다." },
  trickster:{ en: "Rogue",    ko: "도적",     desc: "You read the room before the room reads you.",                     descKo: "방이 당신을 읽기 전에 당신이 방을 읽는다." },
  scholar:  { en: "Mage",     ko: "마법사",   desc: "Understanding is power. You bend the world with your mind.",       descKo: "이해가 힘이다. 당신은 정신으로 세계를 구부린다." },
  speaker:  { en: "Bard",     ko: "음유시인", desc: "You move people. Every room is a stage, every face a story.",      descKo: "당신은 사람을 움직인다. 모든 방이 무대고, 모든 얼굴이 이야기다." },
};

const QUESTIONS: Question[] = [
  {
    text:   "Which path calls to you?",
    textKo: "어떤 길을 걷겠습니까?",
    options: [
      { text: "The Warrior's Path — strength and blade above all else.",        textKo: "전사의 길 — 힘과 칼날이 모든 것에 앞선다.",             archetype: "fighter",   bonus: { strength: 4, will: 2 } },
      { text: "The Rogue's Path — the unseen hand that moves the world.",       textKo: "도적의 길 — 세상을 움직이는 보이지 않는 손.",           archetype: "trickster", bonus: { cunning: 4, reputation: 2 } },
      { text: "The Mage's Path — to understand is to hold power over the world.", textKo: "마법사의 길 — 이해하는 자가 세계를 지배한다.",          archetype: "scholar",   bonus: { will: 4, cunning: 2 } },
      { text: "The Bard's Path — words and music open doors that swords cannot.", textKo: "음유시인의 길 — 말과 음악은 칼이 열지 못하는 문을 연다.", archetype: "speaker",   bonus: { reputation: 4, will: 2 } },
    ],
  },
  {
    text:   "How did you live your life?",
    textKo: "당신은 어떤 삶을 살았나요?",
    options: [
      { text: "I walked battlefields. Steel was my language.",              textKo: "전장을 누볐다. 칼이 내 언어였다.",                archetype: "fighter",   bonus: { strength: 2, will: 1 } },
      { text: "I survived in the shadows. No one remembers my face.",       textKo: "그림자 속에서 살아남았다. 아무도 내 얼굴을 모른다.", archetype: "trickster", bonus: { cunning: 2, reputation: 1 } },
      { text: "I pursued knowledge. I believed every question had an answer.", textKo: "지식을 탐구했다. 답 없는 질문은 없다고 믿었다.",   archetype: "scholar",   bonus: { will: 2, cunning: 1 } },
      { text: "I lived among people. The world moves on relationships.",    textKo: "사람들 속에서 살았다. 세상은 관계로 움직인다.",      archetype: "speaker",   bonus: { reputation: 2, will: 1 } },
    ],
  },
  {
    text:   "When danger finds you, you...",
    textKo: "위기에 처했을 때, 당신은?",
    options: [
      { text: "Face it head-on. Retreat has never been an option.",         textKo: "정면으로 맞선다. 물러서는 건 선택지에 없었다.",      archetype: "fighter",   bonus: { strength: 2, hp: 10 } },
      { text: "Watch for an opening. Strike at the exact right moment.",    textKo: "틈을 본다. 정확히 맞는 순간에 움직인다.",            archetype: "trickster", bonus: { cunning: 2, strength: 1 } },
      { text: "Stay cold. Analyze the problem before letting emotion in.",  textKo: "냉정함을 유지한다. 감정보다 분석이 먼저다.",           archetype: "scholar",   bonus: { will: 2, cunning: 1 } },
      { text: "Rally those around you. You never had to fight alone.",      textKo: "주변을 움직인다. 혼자 싸워야 할 이유가 없었다.",      archetype: "speaker",   bonus: { reputation: 2, will: 1 } },
    ],
  },
  {
    text:   "What do you fear most?",
    textKo: "당신이 가장 두려워하는 것은?",
    options: [
      { text: "Weakness. The day strength finally leaves you.",             textKo: "나약함. 힘이 마침내 떠나는 날.",                    archetype: "fighter",   bonus: { strength: 2, will: 1 } },
      { text: "Being deceived. Someone seeing through you before you see through them.", textKo: "속는 것. 내가 먼저 꿰뚫기 전에 들키는 것.", archetype: "trickster", bonus: { cunning: 2, reputation: 1 } },
      { text: "Ignorance. The thing you cannot understand and cannot stop.", textKo: "무지. 이해도, 막을 수도 없는 것.",                   archetype: "scholar",   bonus: { will: 2, cunning: 1 } },
      { text: "Solitude. A world with no one left in it.",                  textKo: "고독. 아무도 남지 않은 세상.",                       archetype: "speaker",   bonus: { reputation: 2, will: 1 } },
    ],
  },
];

const SKILL_TYPE_META: Record<SkillType, { label: string; labelKo: string; color: string }> = {
  combat:   { label: "Combat",   labelKo: "전투",   color: "text-red-400/80 border-red-500/25 bg-red-950/20" },
  survival: { label: "Survival", labelKo: "생존",   color: "text-green-400/80 border-green-500/25 bg-green-950/20" },
  utility:  { label: "Utility",  labelKo: "실용",   color: "text-blue-400/80 border-blue-500/25 bg-blue-950/20" },
  social:   { label: "Social",   labelKo: "사회",   color: "text-purple-400/80 border-purple-500/25 bg-purple-950/20" },
};

const STAT_LABELS    = { strength: "STR", cunning: "CUN", will: "WIL", reputation: "REP" };
const STAT_LABELS_KO = { strength: "힘",  cunning: "교활", will: "의지", reputation: "명성" };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeStats(answers: number[]): ComputedStats {
  const stats = { ...BASE_STATS };
  answers.forEach((optIdx, qIdx) => {
    const bonus = QUESTIONS[qIdx]?.options[optIdx]?.bonus ?? {};
    if (bonus.strength)   stats.strength   = Math.min(10, stats.strength   + bonus.strength);
    if (bonus.cunning)    stats.cunning    = Math.min(10, stats.cunning    + bonus.cunning);
    if (bonus.will)       stats.will       = Math.min(10, stats.will       + bonus.will);
    if (bonus.reputation) stats.reputation = Math.min(10, stats.reputation + bonus.reputation);
    if (bonus.hp)         { stats.hp += bonus.hp; stats.maxHp += bonus.hp; }
  });
  return stats;
}

function inferArchetype(answers: number[]): Archetype {
  const counts: Record<Archetype, number> = { fighter: 0, trickster: 0, scholar: 0, speaker: 0 };
  answers.forEach((optIdx, qIdx) => {
    const arch = QUESTIONS[qIdx]?.options[optIdx]?.archetype;
    if (arch) counts[arch]++;
  });
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]) as Archetype;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Home() {
  const [, setLocation] = useLocation();
  const { lang, t }     = useLang();

  // Step 1 state
  const [playerName,     setPlayerName]     = useState("");
  const [selectedGenre,  setSelectedGenre]  = useState("");
  const [attempted,      setAttempted]      = useState(false);

  // Step 2 state
  const [answers,        setAnswers]        = useState<number[]>([]);
  const [currentQ,       setCurrentQ]       = useState(0);

  // Step 3 state
  const [skillPool,      setSkillPool]      = useState<Skill[]>([]);
  const [loadingSkills,  setLoadingSkills]  = useState(false);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [skillAttempted, setSkillAttempted] = useState(false);

  // Navigation
  const [step,           setStep]           = useState<1 | 2 | 3>(1);

  // Derived
  const computedStats   = answers.length === QUESTIONS.length ? computeStats(answers) : null;
  const archetype       = answers.length === QUESTIONS.length ? inferArchetype(answers) : null;
  const archetypeInfo   = archetype ? ARCHETYPE_CLASS[archetype] : null;
  const inferredClass   = lang === "ko" ? archetypeInfo?.ko : archetypeInfo?.en;

  // Fetch skill pool when entering step 3
  useEffect(() => {
    if (step !== 3 || !archetypeInfo || !computedStats) return;
    setLoadingSkills(true);
    setSelectedSkillIds([]);
    const { strength: str, cunning: cun, will: wil, reputation: rep } = computedStats;
    const classParam = encodeURIComponent(archetypeInfo.en);
    apiRequest("GET", `/api/game/skill-pool?characterClass=${classParam}&lang=${lang}&str=${str}&cun=${cun}&wil=${wil}&rep=${rep}`)
      .then(r => r.json())
      .then(data => setSkillPool(data.skills ?? []))
      .catch(() => setSkillPool([]))
      .finally(() => setLoadingSkills(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const handleGenreNext = () => {
    setAttempted(true);
    if (!selectedGenre) return;
    setStep(2);
  };

  const handleAnswer = useCallback((optionIndex: number) => {
    const newAnswers = [...answers, optionIndex];
    setAnswers(newAnswers);
    if (currentQ < QUESTIONS.length - 1) {
      setTimeout(() => setCurrentQ(q => q + 1), 120);
    } else {
      // All questions answered — go to skill selection
      setTimeout(() => setStep(3), 180);
    }
  }, [answers, currentQ]);

  const toggleSkill = (id: string, available: boolean) => {
    if (!available) return;
    setSelectedSkillIds(prev => {
      if (prev.includes(id)) return prev.filter(s => s !== id);
      if (prev.length >= 2)  return [...prev.slice(1), id];
      return [...prev, id];
    });
  };

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/game/start", {
        genre:           selectedGenre,
        characterClass:  archetypeInfo?.en ?? "Warrior",
        playerName:      playerName.trim(),
        lang,
        skillIds:        selectedSkillIds,
        customStats:     computedStats,
      });
      return res.json();
    },
    onSuccess: (data) => setLocation(`/game/${data.sessionId}`),
  });

  const handleStartGame = () => {
    setSkillAttempted(true);
    if (selectedSkillIds.length < 2) return;
    startMutation.mutate();
  };

  const question = QUESTIONS[currentQ];

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border/40 px-4 py-3 flex justify-between items-center">
        {/* Back button */}
        <div className="w-20">
          {step > 1 && !startMutation.isPending && (
            <button
              onClick={() => {
                if (step === 2) { setStep(1); setAnswers([]); setCurrentQ(0); }
                if (step === 3) { setStep(2); setAnswers([]); setCurrentQ(0); }
              }}
              className="flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              {lang === "ko" ? "이전" : "Back"}
            </button>
          )}
        </div>
        <LangToggle />
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-4 py-10">
        <AnimatePresence mode="wait">

          {/* ─── STEP 1: Genre ─── */}
          {step === 1 && (
            <motion.div
              key="step1"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.25 }}
              className="w-full max-w-md space-y-8"
            >
              <div className="text-center space-y-2">
                <div className="flex items-center justify-center mb-4">
                  <ScrollText className="w-8 h-8 text-primary" />
                </div>
                <h1 className="text-4xl font-serif font-bold tracking-wide">{t.appName}</h1>
                <p className="text-muted-foreground text-sm">{t.appTagline}</p>
                <p className="text-muted-foreground/60 text-xs">{t.appSub}</p>
              </div>

              <div className="space-y-5">
                <div className="space-y-2">
                  <Label className="text-sm text-foreground/70">{t.characterName}</Label>
                  <Input
                    value={playerName}
                    onChange={e => setPlayerName(e.target.value)}
                    placeholder={t.characterNamePlaceholder}
                    className="bg-card border-border/60"
                    onKeyDown={e => e.key === "Enter" && handleGenreNext()}
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-sm text-foreground/70">
                    {t.genreLabel}
                    <span className="text-red-400 ml-1">*</span>
                  </Label>
                  <div className="grid grid-cols-1 gap-2">
                    {GENRE_KEYS.map(key => {
                      const g = t.genres[key];
                      return (
                        <button
                          key={key}
                          onClick={() => { setSelectedGenre(key); setAttempted(false); }}
                          className={`text-left px-4 py-3 rounded-lg border transition-all ${
                            selectedGenre === key
                              ? "border-primary/60 bg-primary/10 text-foreground"
                              : attempted && !selectedGenre
                                ? "border-red-500/30 bg-card text-muted-foreground hover:text-foreground"
                                : "border-border/40 bg-card hover:border-border/60 text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          <div className="font-medium text-sm">{g.label}</div>
                          <div className="text-xs text-muted-foreground/70 mt-0.5">{g.description}</div>
                        </button>
                      );
                    })}
                  </div>
                  {attempted && !selectedGenre && (
                    <p className="text-xs text-red-400 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      {lang === "ko" ? "장르를 선택하세요" : "Select a genre to begin"}
                    </p>
                  )}
                </div>
              </div>

              <Button className="w-full" size="lg" onClick={handleGenreNext}>
                <Skull className="w-4 h-4 mr-2" />
                {t.beginButton}
              </Button>

              <p className="text-center text-xs text-muted-foreground/40">{t.poweredBy}</p>
            </motion.div>
          )}

          {/* ─── STEP 2: Background Questions ─── */}
          {step === 2 && (
            <motion.div
              key="step2"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.25 }}
              className="w-full max-w-md space-y-6"
            >
              {/* Progress */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-muted-foreground/50">
                  <span>{lang === "ko" ? "과거의 기록" : "Your History"}</span>
                  <span>{currentQ + 1} / {QUESTIONS.length}</span>
                </div>
                <div className="flex gap-1.5">
                  {QUESTIONS.map((_, i) => (
                    <div
                      key={i}
                      className={`h-0.5 flex-1 rounded-full transition-all duration-300 ${
                        i < currentQ ? "bg-primary" : i === currentQ ? "bg-primary/50" : "bg-border/30"
                      }`}
                    />
                  ))}
                </div>
              </div>

              {/* Question card */}
              <AnimatePresence mode="wait">
                <motion.div
                  key={currentQ}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="space-y-5"
                >
                  <h2 className="text-xl font-serif font-semibold text-foreground/90 leading-snug">
                    {lang === "ko" ? question.textKo : question.text}
                  </h2>

                  <div className="space-y-2">
                    {question.options.map((option, idx) => (
                      <motion.button
                        key={idx}
                        whileHover={{ scale: 1.01 }}
                        whileTap={{ scale: 0.99 }}
                        onClick={() => handleAnswer(idx)}
                        className="w-full text-left px-4 py-3.5 rounded-lg border border-border/40 bg-card hover:border-primary/40 hover:bg-primary/5 transition-all text-sm text-foreground/80 hover:text-foreground"
                      >
                        {lang === "ko" ? option.textKo : option.text}
                      </motion.button>
                    ))}
                  </div>
                </motion.div>
              </AnimatePresence>
            </motion.div>
          )}

          {/* ─── STEP 3: Skill Selection ─── */}
          {step === 3 && computedStats && archetypeInfo && (
            <motion.div
              key="step3"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.25 }}
              className="w-full max-w-md space-y-6"
            >
              {/* Character summary */}
              <div className="rounded-lg border border-border/40 bg-card p-4 space-y-3">
                <div className="space-y-0.5">
                  <p className="text-xs text-muted-foreground/50 uppercase tracking-widest">
                    {lang === "ko" ? "당신이 걸어온 길" : "Your Path"}
                  </p>
                  <p className="text-base font-semibold text-foreground">
                    {lang === "ko" ? archetypeInfo.ko : archetypeInfo.en}
                  </p>
                  <p className="text-xs text-muted-foreground/60 italic">
                    {lang === "ko" ? archetypeInfo.descKo : archetypeInfo.desc}
                  </p>
                </div>
                <div className="flex items-center gap-3 text-[11px] flex-wrap pt-1 border-t border-border/20">
                  <span className="text-muted-foreground/40">HP {computedStats.hp}</span>
                  {(["strength", "cunning", "will", "reputation"] as const).map(stat => (
                    <span key={stat} className="text-muted-foreground/60">
                      {lang === "ko" ? STAT_LABELS_KO[stat] : STAT_LABELS[stat]}{" "}
                      <span className="font-semibold text-foreground/70">{computedStats[stat]}</span>
                    </span>
                  ))}
                </div>
              </div>

              {/* Skill picker */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium text-foreground/80">
                      {lang === "ko" ? "스킬 선택" : "Choose Skills"}
                    </p>
                    <p className="text-xs text-muted-foreground/50">
                      {lang === "ko"
                        ? "2개를 선택하세요. 🔒는 스탯 부족으로 잠겨있습니다."
                        : "Pick 2 skills. 🔒 requires higher stats."}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className={`text-xs font-medium ${selectedSkillIds.length === 2 ? "text-primary" : "text-muted-foreground/50"}`}>
                      {selectedSkillIds.length} / 2
                    </span>
                    {selectedSkillIds.length === 2 && <CheckCircle2 className="w-3.5 h-3.5 text-primary" />}
                  </div>
                </div>

                {loadingSkills ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground/40" />
                  </div>
                ) : (
                  <div className="space-y-2">
                    {skillPool.map(skill => {
                      const isSelected  = selectedSkillIds.includes(skill.id);
                      const isAvailable = skill.available !== false;
                      const meta        = SKILL_TYPE_META[skill.skillType as SkillType] ?? SKILL_TYPE_META.combat;
                      const skillName   = lang === "ko" ? skill.nameKo  : skill.name;
                      const skillDesc   = lang === "ko" ? skill.descriptionKo : skill.description;
                      const statLabel   = lang === "ko"
                        ? STAT_LABELS_KO[skill.statBonus] ?? skill.statBonus
                        : STAT_LABELS[skill.statBonus]    ?? skill.statBonus;

                      return (
                        <button
                          key={skill.id}
                          onClick={() => toggleSkill(skill.id, isAvailable)}
                          disabled={!isAvailable}
                          className={`
                            w-full text-left px-3.5 py-3 rounded-lg border transition-all
                            ${isAvailable ? "cursor-pointer" : "cursor-not-allowed opacity-40"}
                            ${isSelected
                              ? "border-primary/60 bg-primary/10 ring-1 ring-primary/30"
                              : isAvailable
                                ? "border-border/40 bg-card hover:border-border/70"
                                : "border-border/20 bg-card/50"
                            }
                          `}
                        >
                          <div className="flex items-start gap-3">
                            <div className="shrink-0 mt-0.5">
                              {isAvailable ? (
                                <div className={`w-4 h-4 rounded border flex items-center justify-center transition-all ${isSelected ? "bg-primary border-primary" : "border-border/50"}`}>
                                  {isSelected && <CheckCircle2 className="w-3 h-3 text-primary-foreground" />}
                                </div>
                              ) : (
                                <Lock className="w-4 h-4 text-muted-foreground/30" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0 space-y-1">
                              <div className="flex items-center gap-2">
                                <span className={`text-sm font-medium ${isAvailable ? "text-foreground" : "text-muted-foreground/50"}`}>
                                  {skillName}
                                </span>
                                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${meta.color}`}>
                                  {lang === "ko" ? meta.labelKo : meta.label}
                                </span>
                              </div>
                              <p className={`text-xs leading-relaxed ${isAvailable ? "text-muted-foreground/65" : "text-muted-foreground/35"}`}>
                                {skillDesc}
                              </p>
                              <div className="flex items-center gap-3 text-[10px] text-muted-foreground/45">
                                <span>
                                  +{skill.bonusValue} {statLabel}
                                  {skill.hpEffect && skill.hpEffect > 0 && <span className="text-green-400/60"> +{skill.hpEffect} HP</span>}
                                  {skill.hpEffect && skill.hpEffect < 0 && <span className="text-red-400/60"> {skill.hpEffect} HP</span>}
                                </span>
                                <span>{lang === "ko" ? `쿨다운 ${skill.cooldown}턴` : `${skill.cooldown}-turn cooldown`}</span>
                                {!isAvailable && skill.statRequirement && (
                                  <span className="text-red-400/50">
                                    🔒 {lang === "ko" ? STAT_LABELS_KO[skill.statRequirement.stat] : STAT_LABELS[skill.statRequirement.stat]} ≥ {skill.statRequirement.min}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {skillAttempted && selectedSkillIds.length < 2 && !loadingSkills && (
                  <p className="text-xs text-red-400 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    {lang === "ko" ? "스킬을 2개 선택하세요" : "Select exactly 2 skills"}
                  </p>
                )}
              </div>

              <Button
                className="w-full"
                size="lg"
                onClick={handleStartGame}
                disabled={startMutation.isPending}
              >
                {startMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t.beginningButton}</>
                ) : (
                  <><Skull className="w-4 h-4 mr-2" />{lang === "ko" ? "모험을 시작하라" : "Begin the Adventure"}</>
                )}
              </Button>

              {startMutation.isError && (
                <p className="text-sm text-red-400 text-center">{t.startError}</p>
              )}

              <p className="text-center text-xs text-muted-foreground/40">{t.poweredBy}</p>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

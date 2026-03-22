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

type StatBonus = { strength?: number; cunning?: number; will?: number; reputation?: number; hp?: number };

type ClassOption = {
  en: string;
  ko: string;
  desc: string;
  descKo: string;
  bonus: StatBonus;
};

type BgOption = {
  text: string;
  textKo: string;
  bonus: StatBonus;
};

type BgQuestion = {
  text: string;
  textKo: string;
  options: BgOption[];
};

type ComputedStats = {
  hp: number; maxHp: number;
  strength: number; cunning: number; will: number; reputation: number;
};

// ─── Config ───────────────────────────────────────────────────────────────────

const GENRE_KEYS = ["fantasy", "dark fantasy", "sci-fi", "horror", "western"] as const;

const BASE_STATS: ComputedStats = { hp: 55, maxHp: 55, strength: 2, cunning: 2, will: 2, reputation: 2 };

const CLASS_OPTIONS: ClassOption[] = [
  {
    en: "Warrior",      ko: "전사",
    desc:   "Your body is your weapon. You endure, push forward, and outlast.",
    descKo: "몸이 무기다. 버티고, 밀어붙이고, 마지막까지 살아남는다.",
    bonus: { strength: 4, will: 1, hp: 15 },
  },
  {
    en: "Rogue",        ko: "도적",
    desc:   "You read the room before the room reads you.",
    descKo: "방이 당신을 읽기 전에 당신이 방을 읽는다.",
    bonus: { cunning: 4, reputation: 2 },
  },
  {
    en: "Mage",         ko: "마법사",
    desc:   "Understanding is power. You bend the world with your mind.",
    descKo: "이해가 힘이다. 당신은 정신으로 세계를 구부린다.",
    bonus: { will: 4, cunning: 2 },
  },
  {
    en: "Paladin",      ko: "성기사",
    desc:   "You carry a sacred light into the darkest places.",
    descKo: "가장 어두운 곳에 신성한 빛을 들고 간다.",
    bonus: { will: 3, strength: 2, reputation: 1, hp: 10 },
  },
  {
    en: "Ranger",       ko: "레인저",
    desc:   "The wild is your home. Your arrow never misses what matters.",
    descKo: "야생이 내 집이다. 화살은 중요한 것을 절대 빗나가지 않는다.",
    bonus: { cunning: 3, strength: 2, hp: 5 },
  },
  {
    en: "Necromancer",  ko: "사령술사",
    desc:   "Death is not an end — it is a resource.",
    descKo: "죽음은 끝이 아니다 — 하나의 자원이다.",
    bonus: { will: 4, cunning: 2 },
  },
  {
    en: "Bard",         ko: "음유시인",
    desc:   "Every room is a stage. Every face is a story waiting to be told.",
    descKo: "모든 방이 무대고, 모든 얼굴이 이야기다.",
    bonus: { reputation: 4, will: 2 },
  },
  {
    en: "Druid",        ko: "드루이드",
    desc:   "You hear what the living world whispers. You answer in kind.",
    descKo: "살아있는 세계가 속삭이는 것을 듣는다. 같은 방식으로 대답한다.",
    bonus: { will: 3, cunning: 2, hp: 5 },
  },
  {
    en: "Ironclad",     ko: "철갑전사",
    desc:   "Nothing stops your advance. Pain is information. You use it.",
    descKo: "아무것도 당신의 전진을 막지 못한다. 고통은 정보다. 이용한다.",
    bonus: { strength: 4, hp: 20 },
  },
  {
    en: "Hexblade",     ko: "저주검사",
    desc:   "Blade and curse — you wield both, and the world suffers for it.",
    descKo: "칼날과 저주 — 둘 다 다루며, 세상은 그 대가를 치른다.",
    bonus: { will: 3, strength: 2, cunning: 1 },
  },
];

const BG_QUESTIONS: BgQuestion[] = [
  {
    text:   "How did you spend your early years?",
    textKo: "어린 시절을 어떻게 보냈나요?",
    options: [
      { text: "Training under a harsh master. Every bruise was a lesson.",        textKo: "혹독한 스승 아래 훈련했다. 모든 멍이 교훈이었다.",                bonus: { strength: 2, will: 1 } },
      { text: "Running errands in narrow alleys. Learning who to trust — and who not to.", textKo: "좁은 골목을 뛰어다녔다. 믿을 자와 믿지 말아야 할 자를 배웠다.", bonus: { cunning: 2, reputation: 1 } },
      { text: "Lost in books and ruins. Every answer led to three more questions.", textKo: "책과 폐허에 빠져 살았다. 모든 답은 세 개의 질문을 낳았다.",          bonus: { will: 2, cunning: 1 } },
      { text: "Growing up among crowds. Learning names, faces, debts, and favors.", textKo: "군중 속에서 자랐다. 이름, 얼굴, 빚, 은혜를 배웠다.",               bonus: { reputation: 2, will: 1 } },
    ],
  },
  {
    text:   "When danger finds you, you...",
    textKo: "위기에 처했을 때, 당신은?",
    options: [
      { text: "Face it head-on. Retreat has never been an option.",          textKo: "정면으로 맞선다. 물러서는 건 선택지에 없었다.",    bonus: { strength: 2, hp: 8 } },
      { text: "Watch for an opening. Strike at the exact right moment.",     textKo: "틈을 노린다. 정확히 맞는 순간에 움직인다.",        bonus: { cunning: 2, strength: 1 } },
      { text: "Stay cold. Analyze the problem before letting emotion in.",   textKo: "냉정함을 유지한다. 감정보다 분석이 먼저다.",        bonus: { will: 2, cunning: 1 } },
      { text: "Rally those around you. You never had to fight alone.",       textKo: "주변을 움직인다. 혼자 싸워야 할 이유가 없었다.",   bonus: { reputation: 2, will: 1 } },
    ],
  },
  {
    text:   "What do you fear most?",
    textKo: "당신이 가장 두려워하는 것은?",
    options: [
      { text: "Weakness. The day strength finally leaves you.",                         textKo: "나약함. 힘이 마침내 떠나는 날.",                     bonus: { strength: 2, will: 1 } },
      { text: "Being deceived. Someone seeing through you before you see through them.", textKo: "속는 것. 내가 먼저 꿰뚫기 전에 들키는 것.",           bonus: { cunning: 2, reputation: 1 } },
      { text: "Ignorance. The thing you cannot understand and cannot stop.",            textKo: "무지. 이해도, 막을 수도 없는 것.",                    bonus: { will: 2, cunning: 1 } },
      { text: "Solitude. A world with no one left in it.",                             textKo: "고독. 아무도 남지 않은 세상.",                        bonus: { reputation: 2, will: 1 } },
    ],
  },
  {
    text:   "What is your greatest strength?",
    textKo: "당신의 가장 큰 강점은 무엇인가요?",
    options: [
      { text: "Endurance. I outlast anything that tries to break me.",   textKo: "인내. 나를 부수려는 것보다 오래 버틴다.",          bonus: { strength: 1, will: 2, hp: 5 } },
      { text: "Observation. Nothing moves without my noticing.",          textKo: "관찰력. 내 눈을 피해 움직이는 것은 없다.",         bonus: { cunning: 3 } },
      { text: "Insight. I see patterns where others see noise.",          textKo: "통찰. 남들이 소음으로 보는 곳에서 패턴을 찾는다.", bonus: { will: 3 } },
      { text: "Connection. People remember me. I make sure of it.",      textKo: "유대감. 사람들이 나를 기억한다. 내가 그걸 확인한다.", bonus: { reputation: 3 } },
    ],
  },
  {
    text:   "Why do you step into the unknown?",
    textKo: "왜 미지의 세계로 발을 내딛나요?",
    options: [
      { text: "To settle a debt written in blood. Someone will answer for it.",    textKo: "피로 쓰인 빚을 갚기 위해. 누군가 그 대가를 치를 것이다.",    bonus: { strength: 2, will: 1 } },
      { text: "Because staying still is slower death. Movement keeps me alive.",   textKo: "가만히 있으면 더 느리게 죽기 때문이다. 움직임이 나를 살린다.", bonus: { cunning: 1, strength: 1, hp: 10 } },
      { text: "There are answers out there. I refuse to die without finding them.", textKo: "거기에 답이 있다. 찾기 전에 죽기를 거부한다.",               bonus: { will: 2, cunning: 1 } },
      { text: "Because someone has to. And I want my name remembered for it.",     textKo: "누군가 해야 하기 때문이다. 그 이름이 기억되길 원한다.",         bonus: { reputation: 2, will: 1 } },
    ],
  },
];

const TOTAL_QUESTIONS = 1 + BG_QUESTIONS.length;

const SKILL_TYPE_META: Record<SkillType, { label: string; labelKo: string; color: string }> = {
  combat:   { label: "Combat",   labelKo: "전투",   color: "text-red-400/80 border-red-500/25 bg-red-950/20" },
  survival: { label: "Survival", labelKo: "생존",   color: "text-green-400/80 border-green-500/25 bg-green-950/20" },
  utility:  { label: "Utility",  labelKo: "실용",   color: "text-blue-400/80 border-blue-500/25 bg-blue-950/20" },
  social:   { label: "Social",   labelKo: "사회",   color: "text-purple-400/80 border-purple-500/25 bg-purple-950/20" },
};

const STAT_LABELS    = { strength: "STR", cunning: "CUN", will: "WIL", reputation: "REP" };
const STAT_LABELS_KO = { strength: "힘",  cunning: "교활", will: "의지", reputation: "명성" };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function applyBonus(stats: ComputedStats, bonus: StatBonus): ComputedStats {
  const s = { ...stats };
  if (bonus.strength)   s.strength   = Math.min(10, s.strength   + bonus.strength);
  if (bonus.cunning)    s.cunning    = Math.min(10, s.cunning    + bonus.cunning);
  if (bonus.will)       s.will       = Math.min(10, s.will       + bonus.will);
  if (bonus.reputation) s.reputation = Math.min(10, s.reputation + bonus.reputation);
  if (bonus.hp)         { s.hp += bonus.hp; s.maxHp += bonus.hp; }
  return s;
}

function computeStats(answers: number[]): ComputedStats {
  let stats = { ...BASE_STATS };
  if (answers.length === 0) return stats;

  // Q1 (index 0) = class choice → apply class bonus
  const classOpt = CLASS_OPTIONS[answers[0]];
  if (classOpt) stats = applyBonus(stats, classOpt.bonus);

  // Q2+ (index 1…) = background questions → apply bg bonuses
  for (let i = 1; i < answers.length; i++) {
    const bgQ   = BG_QUESTIONS[i - 1];
    const bgOpt = bgQ?.options[answers[i]];
    if (bgOpt) stats = applyBonus(stats, bgOpt.bonus);
  }

  return stats;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Home() {
  const [, setLocation] = useLocation();
  const { lang, t }     = useLang();

  // Step 1 state
  const [playerName,       setPlayerName]       = useState("");
  const [selectedGenre,    setSelectedGenre]    = useState("");
  const [attempted,        setAttempted]        = useState(false);

  // Step 2 state: answers[0] = class, answers[1..5] = bg questions
  const [answers,          setAnswers]          = useState<number[]>([]);
  const [currentQ,         setCurrentQ]         = useState(0);

  // Step 3 state
  const [skillPool,        setSkillPool]        = useState<Skill[]>([]);
  const [loadingSkills,    setLoadingSkills]    = useState(false);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [skillAttempted,   setSkillAttempted]   = useState(false);

  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Derived — class is ALWAYS answers[0], never recalculated from later answers
  const allAnswered   = answers.length === TOTAL_QUESTIONS;
  const classOption   = answers.length > 0 ? CLASS_OPTIONS[answers[0]] : null;
  const computedStats = allAnswered ? computeStats(answers) : null;

  // Fetch skill pool when entering step 3
  useEffect(() => {
    if (step !== 3 || !classOption || !computedStats) return;
    setLoadingSkills(true);
    setSelectedSkillIds([]);
    const { strength: str, cunning: cun, will: wil, reputation: rep } = computedStats;
    const classParam = encodeURIComponent(classOption.en);
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
    if (currentQ < TOTAL_QUESTIONS - 1) {
      setTimeout(() => setCurrentQ(q => q + 1), 120);
    } else {
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
        genre:          selectedGenre,
        characterClass: classOption?.en ?? "Warrior",
        playerName:     playerName.trim(),
        lang,
        skillIds:       selectedSkillIds,
        customStats:    computedStats,
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

  // Current question rendering data
  const isClassQuestion = currentQ === 0;
  const bgQuestion      = !isClassQuestion ? BG_QUESTIONS[currentQ - 1] : null;

  const questionText   = isClassQuestion
    ? (lang === "ko" ? "어떤 길을 걷겠습니까?" : "Which path calls to you?")
    : (lang === "ko" ? bgQuestion!.textKo : bgQuestion!.text);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border/40 px-4 py-3 flex justify-between items-center">
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

          {/* ─── STEP 1: Genre & Name ─── */}
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

          {/* ─── STEP 2: Questions ─── */}
          {step === 2 && (
            <motion.div
              key="step2"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.25 }}
              className="w-full max-w-lg space-y-6"
            >
              {/* Progress bar */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-muted-foreground/50">
                  <span>{lang === "ko" ? "과거의 기록" : "Your History"}</span>
                  <span>{currentQ + 1} / {TOTAL_QUESTIONS}</span>
                </div>
                <div className="flex gap-1">
                  {Array.from({ length: TOTAL_QUESTIONS }).map((_, i) => (
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
                  {/* Class question label */}
                  {isClassQuestion && (
                    <p className="text-[10px] uppercase tracking-widest text-primary/60 font-semibold">
                      {lang === "ko" ? "직업 선택" : "Choose Your Class"}
                    </p>
                  )}

                  <h2 className="text-xl font-serif font-semibold text-foreground/90 leading-snug">
                    {questionText}
                  </h2>

                  {/* Class selection: 2-column grid for 10 options */}
                  {isClassQuestion ? (
                    <div className="grid grid-cols-2 gap-2">
                      {CLASS_OPTIONS.map((cls, idx) => (
                        <motion.button
                          key={idx}
                          whileHover={{ scale: 1.02 }}
                          whileTap={{ scale: 0.98 }}
                          onClick={() => handleAnswer(idx)}
                          className="text-left px-3.5 py-3 rounded-lg border border-border/40 bg-card hover:border-primary/40 hover:bg-primary/5 transition-all"
                        >
                          <div className="text-sm font-semibold text-foreground/90">
                            {lang === "ko" ? cls.ko : cls.en}
                          </div>
                          <div className="text-[11px] text-muted-foreground/55 mt-0.5 leading-snug">
                            {lang === "ko" ? cls.descKo : cls.desc}
                          </div>
                        </motion.button>
                      ))}
                    </div>
                  ) : (
                    /* Background questions: single column */
                    <div className="space-y-2">
                      {bgQuestion!.options.map((option, idx) => (
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
                  )}
                </motion.div>
              </AnimatePresence>
            </motion.div>
          )}

          {/* ─── STEP 3: Skill Selection ─── */}
          {step === 3 && computedStats && classOption && (
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
                    {lang === "ko" ? classOption.ko : classOption.en}
                  </p>
                  <p className="text-xs text-muted-foreground/60 italic">
                    {lang === "ko" ? classOption.descKo : classOption.desc}
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

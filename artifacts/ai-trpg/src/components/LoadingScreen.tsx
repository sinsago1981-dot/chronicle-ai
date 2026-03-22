import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { BookOpen } from "lucide-react";
import { useLang } from "@/lib/i18n";

const MESSAGES_EN = [
  "Weaving your chronicle...",
  "The fates are consulting...",
  "Ink bleeds into parchment...",
  "The world stirs around you...",
  "History takes shape...",
  "The die is cast...",
  "Your story begins to breathe...",
];

const MESSAGES_KO = [
  "연대기를 엮는 중...",
  "운명이 협의 중입니다...",
  "잉크가 양피지에 스며듭니다...",
  "세계가 당신 주위에서 깨어납니다...",
  "역사가 형태를 갖춥니다...",
  "주사위가 굴러갑니다...",
  "당신의 이야기가 숨을 쉬기 시작합니다...",
];

const TURN_MESSAGES_EN = [
  "The story continues...",
  "Fate deliberates...",
  "The world responds...",
  "Your action echoes...",
  "The chronicle unfolds...",
];

const TURN_MESSAGES_KO = [
  "이야기가 이어집니다...",
  "운명이 숙고합니다...",
  "세계가 응답합니다...",
  "당신의 행동이 메아리칩니다...",
  "연대기가 펼쳐집니다...",
];

interface LoadingScreenProps {
  variant?: "full" | "turn";
}

export function LoadingScreen({ variant = "full" }: LoadingScreenProps) {
  const { lang } = useLang();

  const messages = variant === "turn"
    ? (lang === "ko" ? TURN_MESSAGES_KO : TURN_MESSAGES_EN)
    : (lang === "ko" ? MESSAGES_KO     : MESSAGES_EN);

  const [msgIndex, setMsgIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setMsgIndex(i => (i + 1) % messages.length);
    }, variant === "turn" ? 1800 : 2400);
    return () => clearInterval(interval);
  }, [messages.length, variant]);

  if (variant === "turn") {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.3 }}
        className="flex flex-col items-center gap-4 py-6"
      >
        <div className="relative w-10 h-10">
          <motion.div
            className="absolute inset-0 rounded-full border border-primary/25"
            animate={{ scale: [1, 1.25, 1], opacity: [0.3, 0.7, 0.3] }}
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.div
            className="absolute inset-0"
            animate={{ rotate: 360 }}
            transition={{ duration: 5, repeat: Infinity, ease: "linear" }}
          >
            {[0, 1, 2].map(i => (
              <div
                key={i}
                className="absolute w-1 h-1 bg-primary/50 rounded-full"
                style={{
                  top: "calc(50% - 2px)",
                  left: "calc(50% - 2px)",
                  transform: `rotate(${i * 120}deg) translateX(16px)`,
                }}
              />
            ))}
          </motion.div>
          <div className="absolute inset-0 flex items-center justify-center">
            <motion.div
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            >
              <BookOpen className="w-4 h-4 text-primary/70" />
            </motion.div>
          </div>
        </div>

        <div className="h-5">
          <AnimatePresence mode="wait">
            <motion.p
              key={msgIndex}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              transition={{ duration: 0.35 }}
              className="text-xs text-muted-foreground/50 tracking-wide text-center"
            >
              {messages[msgIndex]}
            </motion.p>
          </AnimatePresence>
        </div>

        <div className="flex items-center gap-1.5">
          {[0, 1, 2].map(i => (
            <motion.div
              key={i}
              className="w-0.5 h-0.5 bg-primary/40 rounded-full"
              animate={{ opacity: [0.2, 1, 0.2] }}
              transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
            />
          ))}
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5 }}
      className="fixed inset-0 z-50 bg-background flex items-center justify-center overflow-hidden"
    >
      {/* Ambient background glows */}
      <div className="absolute inset-0 pointer-events-none">
        <motion.div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-primary/4 rounded-full blur-3xl"
          animate={{ scale: [1, 1.1, 1], opacity: [0.4, 0.7, 0.4] }}
          transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-72 h-72 bg-violet-500/4 rounded-full blur-3xl"
          animate={{ scale: [1, 1.15, 1], opacity: [0.3, 0.6, 0.3] }}
          transition={{ duration: 5, repeat: Infinity, ease: "easeInOut", delay: 1 }}
        />
      </div>

      {/* Floating particles */}
      {[...Array(8)].map((_, i) => (
        <motion.div
          key={i}
          className="absolute w-px h-px bg-primary/30 rounded-full"
          style={{
            left: `${15 + i * 10}%`,
            top: `${20 + (i % 4) * 18}%`,
          }}
          animate={{
            y: [0, -24, 0],
            opacity: [0, 0.6, 0],
          }}
          transition={{
            duration: 3 + i * 0.4,
            repeat: Infinity,
            delay: i * 0.5,
            ease: "easeInOut",
          }}
        />
      ))}

      <div className="relative text-center space-y-10 px-8">
        {/* Animated icon cluster */}
        <div className="relative mx-auto w-24 h-24 flex items-center justify-center">
          {/* Outer slow pulse ring */}
          <motion.div
            className="absolute inset-0 rounded-full border border-primary/15"
            animate={{ scale: [1, 1.2, 1], opacity: [0.2, 0.5, 0.2] }}
            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
          />
          {/* Inner ring */}
          <motion.div
            className="absolute inset-3 rounded-full border border-primary/25"
            animate={{ scale: [1, 1.08, 1], opacity: [0.3, 0.6, 0.3] }}
            transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut", delay: 0.4 }}
          />

          {/* Orbiting dots */}
          <motion.div
            className="absolute inset-0"
            animate={{ rotate: 360 }}
            transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
          >
            {[0, 1, 2].map(i => (
              <div
                key={i}
                className="absolute w-1.5 h-1.5 bg-primary/45 rounded-full"
                style={{
                  top: "calc(50% - 3px)",
                  left: "calc(50% - 3px)",
                  transform: `rotate(${i * 120}deg) translateX(42px)`,
                }}
              />
            ))}
          </motion.div>

          {/* Counter-rotating small dots */}
          <motion.div
            className="absolute inset-0"
            animate={{ rotate: -360 }}
            transition={{ duration: 13, repeat: Infinity, ease: "linear" }}
          >
            {[0, 1].map(i => (
              <div
                key={i}
                className="absolute w-1 h-1 bg-violet-400/30 rounded-full"
                style={{
                  top: "calc(50% - 2px)",
                  left: "calc(50% - 2px)",
                  transform: `rotate(${i * 180}deg) translateX(30px)`,
                }}
              />
            ))}
          </motion.div>

          {/* Center icon */}
          <motion.div
            animate={{ opacity: [0.6, 1, 0.6] }}
            transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
            className="relative z-10"
          >
            <BookOpen className="w-9 h-9 text-primary" />
          </motion.div>
        </div>

        {/* Title + divider */}
        <div className="space-y-3">
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25, duration: 0.6 }}
            className="text-xs tracking-[0.35em] text-muted-foreground/50 uppercase"
          >
            Chronicle
          </motion.p>
          <motion.div
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ delay: 0.5, duration: 0.9, ease: "easeOut" }}
            className="mx-auto h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent"
            style={{ width: 160 }}
          />
        </div>

        {/* Rotating message */}
        <div className="h-6">
          <AnimatePresence mode="wait">
            <motion.p
              key={msgIndex}
              initial={{ opacity: 0, y: 7 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -7 }}
              transition={{ duration: 0.45 }}
              className="text-sm text-muted-foreground/55 tracking-wide font-light"
            >
              {messages[msgIndex]}
            </motion.p>
          </AnimatePresence>
        </div>

        {/* Progress dots */}
        <div className="flex items-center justify-center gap-2">
          {[0, 1, 2].map(i => (
            <motion.div
              key={i}
              className="w-1 h-1 bg-primary/35 rounded-full"
              animate={{ opacity: [0.2, 1, 0.2] }}
              transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.25 }}
            />
          ))}
        </div>
      </div>
    </motion.div>
  );
}

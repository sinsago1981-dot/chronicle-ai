import { createContext, useContext, useState } from "react";

export type Lang = "en" | "ko";

export const translations = {
  en: {
    appName: "Chronicle",
    appTagline: "An AI-powered tale that bends to your will",
    appSub: "Every choice shapes your destiny",
    characterName: "Character Name",
    characterNamePlaceholder: "Leave blank for a nameless wanderer...",
    classLabel: "Class",
    classPlaceholder: "Choose your path...",
    genreLabel: "Genre",
    beginButton: "Begin the Chronicle",
    beginningButton: "Weaving your fate...",
    startError: "The fates are displeased. Please try again.",
    poweredBy: "Powered by AI — No two tales are alike",
    genres: {
      fantasy: { label: "High Fantasy", description: "Wizards, dragons, ancient prophecies" },
      "dark fantasy": { label: "Dark Fantasy", description: "Grim worlds, moral ambiguity, horror" },
      "sci-fi": { label: "Science Fiction", description: "Space, technology, alien frontiers" },
      horror: { label: "Cosmic Horror", description: "Eldritch entities, madness, the unknown" },
      western: { label: "Weird West", description: "Gunfighters, outlaws, supernatural" },
    },
    newChronicle: "New Chronicle",
    turnLabel: "Turn",
    chronicleComplete: "Chronicle Complete",
    chronicleBegins: "The Chronicle Begins",
    choicePrompt: "What do you do?",
    choseLabel: "You chose:",
    endingTitle: "Your chronicle has ended.",
    endingSubtitle: "Fate has written its final word.",
    loadingStory: "The tale unfolds...",
    choiceError: "The fates were disrupted. Please choose again.",
    beginNewChronicle: "Begin a New Chronicle",
    tapToContinue: "tap to continue",
    tapForChoices: "tap to reveal choices",
    stats: {
      hp: "HP",
      strength: "STR",
      cunning: "CUN",
      will: "WIL",
      reputation: "REP",
      hpFull: "Health",
      strengthFull: "Strength",
      cunningFull: "Cunning",
      willFull: "Will",
      reputationFull: "Reputation",
    },
    deathTitle: "You have fallen.",
    deathSubtitle: "Your wounds were too great. The chronicle ends here.",
    dice: {
      roll: "Roll",
      total: "Total",
      modifier: "modifier",
      outcomes: {
        critical_failure: "Critical Failure",
        failure: "Failure",
        partial: "Partial Success",
        success: "Success",
        critical_success: "Critical Success",
      },
      statNames: {
        strength: "STR",
        cunning: "CUN",
        will: "WIL",
        reputation: "REP",
      },
    },
  },
  ko: {
    appName: "Chronicle",
    appTagline: "AI가 이끄는 당신만의 이야기",
    appSub: "모든 선택이 운명을 바꾼다",
    characterName: "캐릭터 이름",
    characterNamePlaceholder: "비워두면 이름 없는 방랑자로 시작합니다...",
    classLabel: "직업",
    classPlaceholder: "직업을 선택하세요...",
    genreLabel: "장르",
    beginButton: "연대기를 시작하라",
    beginningButton: "운명을 짜는 중...",
    startError: "운명이 거부했습니다. 다시 시도해주세요.",
    poweredBy: "AI 기반 — 매번 다른 이야기",
    genres: {
      fantasy: { label: "하이 판타지", description: "마법사, 용, 고대의 예언" },
      "dark fantasy": { label: "다크 판타지", description: "암울한 세계, 도덕적 갈등, 공포" },
      "sci-fi": { label: "SF", description: "우주, 기술, 미지의 개척지" },
      horror: { label: "우주적 공포", description: "엘드리치 존재, 광기, 미지의 것" },
      western: { label: "기묘한 서부", description: "총잡이, 무법자, 초자연" },
    },
    newChronicle: "새 연대기",
    turnLabel: "턴",
    chronicleComplete: "연대기 완료",
    chronicleBegins: "연대기가 시작된다",
    choicePrompt: "어떻게 하겠습니까?",
    choseLabel: "선택:",
    endingTitle: "연대기가 끝났습니다.",
    endingSubtitle: "운명은 마지막 말을 적었습니다.",
    loadingStory: "이야기가 펼쳐지고 있습니다...",
    choiceError: "운명이 방해받았습니다. 다시 선택해주세요.",
    beginNewChronicle: "새 연대기 시작",
    tapToContinue: "탭하여 계속",
    tapForChoices: "탭하여 선택지 보기",
    stats: {
      hp: "HP",
      strength: "힘",
      cunning: "교활",
      will: "의지",
      reputation: "명성",
      hpFull: "생명력",
      strengthFull: "힘",
      cunningFull: "교활함",
      willFull: "의지",
      reputationFull: "명성",
    },
    deathTitle: "쓰러졌습니다.",
    deathSubtitle: "상처가 너무 깊었습니다. 연대기는 여기서 끝납니다.",
    dice: {
      roll: "굴림",
      total: "합계",
      modifier: "보정",
      outcomes: {
        critical_failure: "대실패",
        failure: "실패",
        partial: "부분 성공",
        success: "성공",
        critical_success: "대성공",
      },
      statNames: {
        strength: "힘",
        cunning: "교활",
        will: "의지",
        reputation: "명성",
      },
    },
  },
} as const;

type Translations = typeof translations.en;

const LangContext = createContext<{
  lang: Lang;
  setLang: (l: Lang) => void;
  t: Translations;
}>({
  lang: "en",
  setLang: () => {},
  t: translations.en,
});

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    return (localStorage.getItem("chronicle-lang") as Lang) || "en";
  });

  const setLang = (l: Lang) => {
    setLangState(l);
    localStorage.setItem("chronicle-lang", l);
  };

  return (
    <LangContext.Provider value={{ lang, setLang, t: translations[lang] }}>
      {children}
    </LangContext.Provider>
  );
}

export function useLang() {
  return useContext(LangContext);
}

import { useLang } from "@/lib/i18n";

export function LangToggle() {
  const { lang, setLang } = useLang();

  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border/60 overflow-hidden text-xs font-medium">
      <button
        onClick={() => setLang("en")}
        className={`px-2.5 py-1 transition-colors ${
          lang === "en"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
        }`}
      >
        EN
      </button>
      <button
        onClick={() => setLang("ko")}
        className={`px-2.5 py-1 transition-colors ${
          lang === "ko"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
        }`}
      >
        한국어
      </button>
    </div>
  );
}

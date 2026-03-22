import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ShoppingBag, ChevronDown, ChevronUp, Zap, Shield, Key, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Item, ItemType } from "@/types";
import { useLang } from "@/lib/i18n";

type Tab = "all" | ItemType;

const RARITY_COLOR: Record<string, string> = {
  common:    "text-foreground/60 border-border/40",
  uncommon:  "text-green-400 border-green-500/30",
  rare:      "text-blue-400 border-blue-500/30",
  legendary: "text-yellow-400 border-yellow-500/40",
};

const RARITY_BG: Record<string, string> = {
  common:    "bg-background/40",
  uncommon:  "bg-green-950/20",
  rare:      "bg-blue-950/20",
  legendary: "bg-yellow-950/20",
};

function TypeIcon({ type }: { type: ItemType }) {
  if (type === "equipment") return <Shield className="w-3 h-3" />;
  if (type === "key_item")  return <Key className="w-3 h-3" />;
  return <Zap className="w-3 h-3" />;
}

function formatEffect(effect: Item["effect"], lang: string): string {
  const parts: string[] = [];
  const labels: Record<string, Record<string, string>> = {
    hp:         { en: "HP",  ko: "HP" },
    strength:   { en: "STR", ko: "STR" },
    cunning:    { en: "CUN", ko: "CUN" },
    will:       { en: "WIL", ko: "WIL" },
    reputation: { en: "REP", ko: "REP" },
  };
  for (const [k, v] of Object.entries(effect ?? {})) {
    if (v && v !== 0) {
      const lbl = labels[k]?.[lang] ?? k.toUpperCase();
      parts.push(`${v > 0 ? "+" : ""}${v} ${lbl}`);
    }
  }
  return parts.join(" · ");
}

interface ItemsPanelProps {
  inventory:      Item[];
  onUse:          (itemId: string) => void;
  onEquip:        (itemId: string) => void;
  isPending?:     boolean;
}

export function ItemsPanel({ inventory, onUse, onEquip, isPending }: ItemsPanelProps) {
  const { lang } = useLang();
  const [open, setOpen]   = useState(false);
  const [tab,  setTab]    = useState<Tab>("all");

  const totalCount = inventory.reduce((s, i) => s + (i.quantity ?? 1), 0);

  const filtered = useMemo(() => {
    if (tab === "all") return inventory;
    return inventory.filter(i => i.type === tab);
  }, [inventory, tab]);

  const tabs: { id: Tab; label: string; labelKo: string }[] = [
    { id: "all",        label: "All",         labelKo: "전체"   },
    { id: "consumable", label: "Consumable",   labelKo: "소모품" },
    { id: "equipment",  label: "Equipment",    labelKo: "장비"   },
    { id: "key_item",   label: "Key Items",    labelKo: "핵심"   },
  ];

  if (inventory.length === 0) return null;

  return (
    <div className="border border-border/30 rounded-lg overflow-hidden">
      {/* Header toggle */}
      <button
        className="w-full flex items-center justify-between px-3 py-2 bg-background/60 hover:bg-background/80 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2 text-sm text-muted-foreground/80">
          <ShoppingBag className="w-3.5 h-3.5" />
          <span className="font-medium">{lang === "ko" ? "인벤토리" : "Inventory"}</span>
          <span className="text-xs bg-primary/15 text-primary/80 px-1.5 py-0.5 rounded-full font-mono">
            {totalCount}
          </span>
        </div>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground/50" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/50" />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            key="items-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{ overflow: "hidden" }}
          >
            {/* Tabs */}
            <div className="flex gap-1 px-2 pt-2 pb-1 border-t border-border/20">
              {tabs.map(t => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`text-[10px] font-semibold px-2 py-1 rounded-md transition-colors ${
                    tab === t.id
                      ? "bg-primary/20 text-primary"
                      : "text-muted-foreground/50 hover:text-muted-foreground/80"
                  }`}
                >
                  {lang === "ko" ? t.labelKo : t.label}
                </button>
              ))}
            </div>

            {/* Items */}
            <div className="px-2 pb-2 space-y-1 max-h-60 overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/40 px-1 py-2 text-center">
                  {lang === "ko" ? "아이템 없음" : "No items"}
                </p>
              ) : (
                filtered.map(item => {
                  const name   = lang === "ko" ? item.nameKo   : item.name;
                  const desc   = lang === "ko" ? item.descriptionKo : item.description;
                  const eff    = formatEffect(item.effect, lang);
                  const rColor = RARITY_COLOR[item.rarity] ?? RARITY_COLOR.common;
                  const rBg    = RARITY_BG[item.rarity]   ?? RARITY_BG.common;

                  return (
                    <motion.div
                      key={item.id}
                      layout
                      className={`flex items-start gap-2 p-2 rounded-lg border ${rColor} ${rBg}`}
                    >
                      <span className="text-base shrink-0 mt-0.5">{item.icon || "📦"}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs font-semibold truncate">{name}</span>
                          {item.rarity !== "common" && (
                            <Star className={`w-2.5 h-2.5 shrink-0 ${rColor.split(" ")[0]}`} />
                          )}
                          <TypeIcon type={item.type} />
                          {item.quantity > 1 && (
                            <span className="text-[10px] text-muted-foreground/50 font-mono">×{item.quantity}</span>
                          )}
                          {item.equipped && (
                            <span className="text-[10px] bg-primary/20 text-primary px-1 rounded">
                              {lang === "ko" ? "장착 중" : "equipped"}
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-muted-foreground/50 leading-tight mt-0.5 line-clamp-2">{desc}</p>
                        {eff && (
                          <p className="text-[10px] font-bold text-primary/70 mt-0.5">{eff}</p>
                        )}
                      </div>

                      {/* Action button */}
                      {item.type === "consumable" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={isPending}
                          onClick={() => onUse(item.id)}
                          className="h-6 text-[10px] px-1.5 text-primary/70 hover:text-primary shrink-0"
                        >
                          {lang === "ko" ? "사용" : "Use"}
                        </Button>
                      )}
                      {item.type === "equipment" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={isPending}
                          onClick={() => onEquip(item.id)}
                          className={`h-6 text-[10px] px-1.5 shrink-0 ${item.equipped ? "text-yellow-400/80 hover:text-yellow-400" : "text-primary/70 hover:text-primary"}`}
                        >
                          {item.equipped
                            ? (lang === "ko" ? "해제" : "Unequip")
                            : (lang === "ko" ? "장착" : "Equip")}
                        </Button>
                      )}
                    </motion.div>
                  );
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

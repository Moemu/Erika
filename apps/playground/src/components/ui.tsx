/** shadcn-style local components (no Radix dependency for v1): the handful of
 * primitives the playground needs, styled with Tailwind v4 tokens. */

import { useI18n } from "../lib/i18n.js";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function Button({
  variant = "ghost",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" }) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-all",
        "focus-visible:outline-2 focus-visible:outline-brand-400 disabled:opacity-50",
        variant === "primary"
          ? "bg-gradient-to-b from-brand-400 to-brand-500 text-ink-950 font-medium shadow-sm hover:brightness-110 active:brightness-95"
          : "bg-ink-850 text-ink-200 border border-ink-700 hover:bg-ink-800 hover:text-ink-100",
        className,
      )}
      {...props}
    />
  );
}

export function TextInput({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "w-full rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-sm text-ink-100",
        "placeholder:text-ink-600 transition-colors focus:border-brand-500/70 focus:outline-none focus:ring-1 focus:ring-brand-500/40",
        className,
      )}
      {...props}
    />
  );
}

export function Select({
  className,
  options,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      className={cn(
        "w-full appearance-none rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-sm text-ink-100",
        "transition-colors focus:border-brand-500/70 focus:outline-none focus:ring-1 focus:ring-brand-500/40",
        className,
      )}
      {...props}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-ink-850 text-ink-100">
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs text-ink-300">
        <span>{label}</span>
        {hint && <span className="text-ink-600">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const feedback = copied ? t("copied") : failed ? t("copyFailed") : label ?? t("copy");
  return (
    <Button
      aria-label={feedback}
      onClick={async () => {
        try {
          setFailed(false);
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          setFailed(true);
        }
      }}
      className={cn(className, copied && "text-emerald-300")}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      <span role="status">{feedback}</span>
    </Button>
  );
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: string; label: string }>;
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg bg-ink-850 p-1 border border-ink-700/70" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "flex-1 rounded-md px-2 py-1 text-xs transition-all",
            active === t.id
              ? "bg-brand-500/15 text-brand-600 shadow-[inset_0_0_0_1px_rgba(115,104,140,0.35)]"
              : "text-ink-300 hover:text-ink-100",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

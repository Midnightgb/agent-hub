import { cn } from "@/lib/utils"

/**
 * Static asset map for provider icons.
 * When SVG assets are added under dashboard/public/providers/<key>.svg,
 * register their paths here (e.g. { agy: "/providers/agy.svg" }) to render
 * an <img> rather than the monogram fallback badge.
 */
export const PROVIDER_ASSETS: Record<string, string> = {}

const PALETTES: Record<string, string> = {
  agy: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 dark:bg-indigo-500/25",
  opencode: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 dark:bg-emerald-500/25",
  copilot: "bg-sky-500/15 text-sky-700 dark:text-sky-300 dark:bg-sky-500/25",
  codex: "bg-teal-500/15 text-teal-700 dark:text-teal-300 dark:bg-teal-500/25",
  "gentle-shell": "bg-rose-500/15 text-rose-700 dark:text-rose-300 dark:bg-rose-500/25",
  jules: "bg-amber-500/15 text-amber-700 dark:text-amber-300 dark:bg-amber-500/25",
  claude: "bg-orange-500/15 text-orange-700 dark:text-orange-300 dark:bg-orange-500/25",
  unknown: "bg-muted text-muted-foreground",
}

export interface ProviderMarkProps {
  agent: string
  size?: "sm" | "md"
  className?: string
}

export function ProviderMark({ agent, size = "md", className }: ProviderMarkProps) {
  const key = (agent || "").toLowerCase().trim()
  const assetSrc = PROVIDER_ASSETS[key]

  const sizeClasses =
    size === "sm"
      ? "size-6 text-[10px]"
      : "size-8 text-xs"

  if (assetSrc) {
    return (
      <img
        src={assetSrc}
        alt={agent}
        className={cn(
          "inline-block rounded-md object-contain shrink-0 select-none",
          sizeClasses,
          className
        )}
      />
    )
  }

  const palette = PALETTES[key] ?? PALETTES.unknown
  const cleaned = agent ? agent.trim() : "??"
  const monogram = (cleaned.length >= 2 ? cleaned.slice(0, 2) : cleaned.padEnd(2, "?")).toUpperCase()

  return (
    <span
      data-slot="provider-mark"
      data-provider={key}
      data-size={size}
      className={cn(
        "inline-flex items-center justify-center rounded-md font-mono font-semibold shrink-0 select-none",
        sizeClasses,
        palette,
        className
      )}
      title={agent}
      aria-hidden="true"
    >
      {monogram}
    </span>
  )
}

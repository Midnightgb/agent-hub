import * as React from "react"
import DotGrid from "@/components/reactbits/DotGrid"
import { useTheme, type ThemeChoice } from "@/components/theme-provider"

// Zinc-spectrum colors matching the light and dark theme tokens. The dots
// rest close to the page background so the grid stays subtle, and only light
// up toward the accent near the cursor.
const LIGHT_COLORS = { baseColor: "#e4e4e7", activeColor: "#52525b" }
const DARK_COLORS = { baseColor: "#27272a", activeColor: "#a1a1aa" }

function useIsDark(theme: ThemeChoice): boolean {
  const [systemDark, setSystemDark] = React.useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false
    return window.matchMedia("(prefers-color-scheme: dark)").matches
  })

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return
    const mql = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    if (mql.addEventListener) {
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    } else if (mql.addListener) {
      mql.addListener(onChange)
      return () => mql.removeListener(onChange)
    }
  }, [])

  if (theme === "dark") return true
  if (theme === "light") return false
  return systemDark
}

function useSafeTheme(): ThemeChoice {
  try {
    return useTheme().theme
  } catch {
    return "dark"
  }
}

export function AppBackground() {
  const theme = useSafeTheme()
  const isDark = useIsDark(theme)
  const colors = isDark ? DARK_COLORS : LIGHT_COLORS

  // DotGrid honors prefers-reduced-motion itself (no intro, push or shock).
  return (
    <div
      data-testid="app-background"
      className="absolute inset-0 -z-10 pointer-events-none"
      aria-hidden="true"
    >
      <DotGrid
        {...colors}
        shape="circle"
        dotSize={3}
        gap={22}
        proximity={140}
        glow={0.4}
        swell={0.6}
        fade={0.3}
      />
    </div>
  )
}

export default AppBackground

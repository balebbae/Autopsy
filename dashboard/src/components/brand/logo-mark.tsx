import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Autopsy mark — a minimalist pulse-stitched "A":
 *
 *      /\
 *     /  \           <- A legs
 *  ──/────\──        <- ECG pulse cuts horizontally through the
 *   /      \           cross-bar position
 *
 * The two diagonal strokes read as the letter A; the heartbeat-style
 * line evokes the forensic / vital-signs angle of recording every agent
 * run. Single-stroke, single-colour: inherits ``currentColor`` so it
 * reskins for free in light + dark themes.
 */
export function LogoMark({
  className,
  ...rest
}: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("text-foreground", className)}
      {...rest}
    >
      {/* A legs */}
      <path d="M16 4 L5.5 27 M16 4 L26.5 27" />
      {/* horizontal ECG / pulse forming the cross-bar */}
      <path
        d="M3 18 L9 18 L11 14 L13 21 L16 13 L19 21 L21 14 L23 18 L29 18"
        strokeWidth={1.6}
      />
    </svg>
  )
}

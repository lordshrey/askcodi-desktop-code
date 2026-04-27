import { motion, AnimatePresence } from "motion/react"
import { HelpCircle } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "../../lib/utils"

const TOTAL_STEPS = 3

type CarouselShellProps = {
  step: 0 | 1 | 2
  /** Step the user is allowed to navigate to via dot click. */
  canGoTo: (step: 0 | 1 | 2) => boolean
  onStepChange: (step: 0 | 1 | 2) => void
  children: ReactNode
}

export function CarouselShell({
  step,
  canGoTo,
  onStepChange,
  children,
}: CarouselShellProps) {
  return (
    <div className="fixed inset-0 flex flex-col bg-background text-foreground">
      {/* Spacer for the Electron window chrome / drag region */}
      <div className="h-10 shrink-0" data-electron-drag />

      {/* Active step body */}
      <div className="flex-1 flex items-center justify-center px-6 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="w-full max-w-2xl"
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Bottom: dot pagination */}
      <div className="shrink-0 pb-10 pt-4 flex items-center justify-center gap-2">
        {Array.from({ length: TOTAL_STEPS }).map((_, idx) => {
          const isActive = idx === step
          const reachable = canGoTo(idx as 0 | 1 | 2)
          return (
            <button
              key={idx}
              type="button"
              aria-label={`Step ${idx + 1}`}
              aria-current={isActive ? "step" : undefined}
              disabled={!reachable}
              onClick={() => reachable && onStepChange(idx as 0 | 1 | 2)}
              className={cn(
                "h-2 rounded-full transition-all duration-200 ease-out",
                isActive
                  ? "w-6 bg-primary"
                  : "w-2 bg-border hover:bg-muted-foreground/60",
                !reachable && "cursor-not-allowed opacity-40 hover:bg-border",
              )}
            />
          )
        })}
      </div>

      {/* Bottom-left: Get support */}
      <button
        type="button"
        onClick={() =>
          window.desktopApi?.openExternal?.("https://askcodi.com/support")
        }
        className="absolute bottom-6 left-6 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <HelpCircle className="size-3.5" />
        Get support
      </button>
    </div>
  )
}

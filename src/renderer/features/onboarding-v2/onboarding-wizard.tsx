import { useAtom, useSetAtom } from "jotai"
import { useEffect, useRef } from "react"
import {
  onboardingCurrentStepAtom,
  onboardingCompletedAtom,
  type OnboardingStep,
} from "../../lib/atoms"
import {
  selectedProjectAtom,
  type SelectedProject,
} from "../agents/atoms"
import { CarouselShell } from "./carousel-shell"
import { GithubStep } from "./steps/github-step"
import { AgentsStep } from "./steps/agents-step"
import { RepoStep } from "./steps/repo-step"

type StepId = OnboardingStep // 0 = GitHub, 1 = Agents, 2 = Repo

export function OnboardingWizard() {
  const [step, setStep] = useAtom(onboardingCurrentStepAtom)
  const setCompleted = useSetAtom(onboardingCompletedAtom)
  const setSelectedProject = useSetAtom(selectedProjectAtom)
  const furthestStepRef = useRef<StepId>(step)

  // Track the furthest step the user has reached so dot pagination can
  // jump back to earlier steps but not skip ahead.
  useEffect(() => {
    if (step > furthestStepRef.current) {
      furthestStepRef.current = step
    }
  }, [step])

  const goToStep = (next: StepId) => {
    if (next > furthestStepRef.current) return
    setStep(next)
  }

  const advance = () => {
    if (step >= 2) return
    setStep((step + 1) as StepId)
  }

  const completeWizard = (project: NonNullable<SelectedProject>) => {
    setSelectedProject(project)
    setCompleted(true)
  }

  return (
    <CarouselShell
      step={step}
      canGoTo={(s) => s <= furthestStepRef.current}
      onStepChange={goToStep}
    >
      {step === 0 && <GithubStep onNext={advance} />}
      {step === 1 && <AgentsStep onNext={advance} />}
      {step === 2 && <RepoStep onComplete={completeWizard} />}
    </CarouselShell>
  )
}

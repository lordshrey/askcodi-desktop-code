import { useEffect, useMemo, useState } from "react"
import { Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { trpc } from "@/lib/trpc"

interface HireAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const ROLE_PRESETS = [
  { value: "ceo", label: "CEO" },
  { value: "engineer", label: "Engineer" },
  { value: "designer", label: "Designer" },
  { value: "researcher", label: "Researcher" },
  { value: "general", label: "General" },
]

export function HireAgentDialog({ open, onOpenChange }: HireAgentDialogProps) {
  const utils = trpc.useUtils()
  const { data: availableAdapters = [] } = trpc.runtimeAgents.listAvailableAdapters.useQuery(undefined, {
    enabled: open,
  })

  const [name, setName] = useState("")
  const [role, setRole] = useState("engineer")
  const [adapterType, setAdapterType] = useState<"claude_code" | "claude_api" | "codex" | "cursor" | "ollama">("claude_code")
  const [model, setModel] = useState<string>("")
  const [autonomyMode, setAutonomyMode] = useState<"off" | "event" | "timer">("event")
  const [budgetDollars, setBudgetDollars] = useState<string>("")
  const [envCheckMessage, setEnvCheckMessage] = useState<string | null>(null)
  const [envCheckOk, setEnvCheckOk] = useState<boolean | null>(null)

  const adapter = useMemo(
    () => availableAdapters.find((a) => a.type === adapterType),
    [availableAdapters, adapterType],
  )

  // Default model on adapter change
  useEffect(() => {
    if (adapter && adapter.models.length > 0 && !model) {
      setModel(adapter.models[0].id)
    }
  }, [adapter, model])

  // Reset on close
  useEffect(() => {
    if (!open) {
      setName("")
      setRole("engineer")
      setAdapterType("claude_code")
      setModel("")
      setAutonomyMode("event")
      setBudgetDollars("")
      setEnvCheckMessage(null)
      setEnvCheckOk(null)
    }
  }, [open])

  const testEnvMutation = trpc.runtimeAgents.testAdapterEnvironment.useMutation()
  const hireMutation = trpc.runtimeAgents.hire.useMutation({
    onSuccess: () => {
      void utils.runtimeAgents.list.invalidate()
      onOpenChange(false)
    },
    onError: (error) => {
      setEnvCheckOk(false)
      setEnvCheckMessage(error.message)
    },
  })

  const onTestEnv = async () => {
    setEnvCheckMessage("Checking...")
    setEnvCheckOk(null)
    try {
      const result = await testEnvMutation.mutateAsync({
        adapterType,
        config: { model },
      })
      setEnvCheckOk(result.ok)
      setEnvCheckMessage(result.ok ? result.message : `${result.message}${result.fixHint ? ` — ${result.fixHint}` : ""}`)
    } catch (error) {
      setEnvCheckOk(false)
      setEnvCheckMessage((error as Error).message)
    }
  }

  const canSubmit = name.trim().length > 0 && model.length > 0 && !hireMutation.isPending

  const onSubmit = () => {
    const budgetCents = budgetDollars ? Math.round(parseFloat(budgetDollars) * 100) : null
    hireMutation.mutate({
      name: name.trim(),
      role,
      adapterType,
      adapterConfig: { model },
      autonomyMode,
      budgetMonthlyCents: budgetCents,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Hire an agent</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Engineer Alpha"
              className="mt-1.5"
              autoFocus
            />
          </div>

          <div>
            <Label htmlFor="agent-role">Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="agent-role" className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_PRESETS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="agent-adapter">Adapter</Label>
            <Select value={adapterType} onValueChange={(v) => setAdapterType(v as typeof adapterType)}>
              <SelectTrigger id="agent-adapter" className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableAdapters.map((a) => (
                  <SelectItem key={a.type} value={a.type}>
                    {a.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {adapter?.description && (
              <p className="mt-1 text-xs text-muted-foreground">{adapter.description}</p>
            )}
          </div>

          {adapter && adapter.models.length > 0 && (
            <div>
              <Label htmlFor="agent-model">Model</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger id="agent-model" className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {adapter.models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div>
            <Label htmlFor="agent-autonomy">Autonomy</Label>
            <Select value={autonomyMode} onValueChange={(v) => setAutonomyMode(v as typeof autonomyMode)}>
              <SelectTrigger id="agent-autonomy" className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off — only on-demand</SelectItem>
                <SelectItem value="event">Event-driven (recommended)</SelectItem>
                <SelectItem value="timer">Timer + events (full autonomy)</SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              Controls whether the agent wakes itself on schedule or waits for assignments.
            </p>
          </div>

          <div>
            <Label htmlFor="agent-budget">Monthly budget (USD, optional)</Label>
            <Input
              id="agent-budget"
              type="number"
              step="0.01"
              min="0"
              value={budgetDollars}
              onChange={(e) => setBudgetDollars(e.target.value)}
              placeholder="e.g. 50.00"
              className="mt-1.5"
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onTestEnv}
              disabled={testEnvMutation.isPending}
            >
              {testEnvMutation.isPending && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
              Test environment
            </Button>
            {envCheckMessage && (
              <span
                className={
                  envCheckOk === true
                    ? "text-xs text-emerald-500"
                    : envCheckOk === false
                      ? "text-xs text-red-500"
                      : "text-xs text-muted-foreground"
                }
              >
                {envCheckMessage}
              </span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {hireMutation.isPending && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
            Hire agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import * as api from "./api"
import { qk } from "./query-keys"
import type { LearningInputT, CloudAccountPatch, CloudSchedulePatch, AgysModeInput } from './types'

const STATE_REFETCH_INTERVAL_MS = 15000

export function useStateQuery() {
  return useQuery({
    queryKey: qk.state,
    queryFn: api.getState,
    refetchInterval: STATE_REFETCH_INTERVAL_MS,
  })
}

export function useConfigQuery() {
  return useQuery({ queryKey: qk.config, queryFn: api.getConfig })
}

export function useMetricsQuery() {
  return useQuery({ queryKey: qk.metrics, queryFn: api.getMetrics })
}

export function useQuotaQuery() {
  return useQuery({ queryKey: ['quota'], queryFn: api.getQuota })
}

export function useProvidersQuery() {
  return useQuery({ queryKey: qk.providers, queryFn: api.getProviders })
}

export function useSetProvidersModeMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: AgysModeInput) => api.setProvidersMode(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.providers }),
  })
}

export function useProposalsQuery() {
  return useQuery({ queryKey: qk.proposals, queryFn: api.getProposals })
}

export function useLearningsQuery() {
  return useQuery({ queryKey: qk.learnings, queryFn: api.getLearnings })
}

export function useRefreshAgentsMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.refreshAgents,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.state }),
  })
}

export function useRefreshDiscoveryMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.refreshDiscovery,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.config }),
  })
}

export function useSetOverrideMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.setOverride,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.config }),
  })
}

export function useClearOverrideMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ agent, model }: { agent: string; model: string }) => api.clearOverride(agent, model),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.config }),
  })
}

export function useModelPolicyQuery(agent = "opencode") {
  return useQuery({ queryKey: qk.modelPolicy(agent), queryFn: () => api.getModelPolicy(agent) })
}

export function useSetModelDecisionMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.setModelDecision,
    onSuccess: (_data, vars) => queryClient.invalidateQueries({ queryKey: qk.modelPolicy(vars.agent) }),
  })
}

export function useSetModelOrderMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.setModelOrder,
    onSuccess: (_data, vars) => queryClient.invalidateQueries({ queryKey: qk.modelPolicy(vars.agent) }),
  })
}

export function useCancelJobMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.cancelJob,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.state }),
  })
}

export function useRefreshProposalsMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.refreshProposals,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.proposals }),
  })
}

export function useDecideProposalMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "accept" | "reject" }) =>
      api.decideProposal(id, decision),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.proposals }),
  })
}

export function useDecideLearningMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approve" | "reject" }) =>
      api.decideLearning(id, decision),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.learnings }),
  })
}

export function useAccountsQuery() {
  return useQuery({ queryKey: qk.accounts, queryFn: api.getAccounts })
}

export function useCreateAccountMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: Parameters<typeof api.createAccount>[0]) => api.createAccount(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.accounts })
      queryClient.invalidateQueries({ queryKey: qk.sources })
    },
  })
}

export function useUpdateAccountMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: CloudAccountPatch }) => api.updateAccount(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.accounts }),
  })
}

export function useDeleteAccountMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteAccount(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.accounts })
      queryClient.invalidateQueries({ queryKey: qk.sources })
    },
  })
}

export function useSetAccountPolicyMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (policy: Parameters<typeof api.setAccountPolicy>[0]) => api.setAccountPolicy(policy),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.accounts }),
  })
}

export function useRefreshAccountSourcesMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.refreshAccountSources(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.accounts })
      queryClient.invalidateQueries({ queryKey: qk.sources })
    },
  })
}

export function useSourcesQuery() {
  return useQuery({ queryKey: qk.sources, queryFn: api.getSources })
}

export function useSchedulesQuery() {
  return useQuery({ queryKey: qk.schedules, queryFn: api.getSchedules })
}

export function useCreateScheduleMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: Parameters<typeof api.createSchedule>[0]) => api.createSchedule(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.schedules }),
  })
}

export function useUpdateScheduleMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: CloudSchedulePatch }) => api.updateSchedule(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.schedules }),
  })
}

export function useDeleteScheduleMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.schedules }),
  })
}

export function useRunScheduleNowMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.runScheduleNow(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.schedules }),
  })
}

export function useCloudSessionsQuery() {
  return useQuery({ queryKey: qk.sessions, queryFn: api.getCloudSessions })
}

export function useCheckCloudJobMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.checkCloudJob(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.sessions }),
  })
}

export function useCloudJobActivitiesQuery(id: string | null) {
  return useQuery({
    queryKey: id ? qk.activities(id) : [],
    queryFn: () => (id ? api.getCloudJobActivities(id) : Promise.reject(new Error("No id"))),
    enabled: !!id,
  })
}

export function useDeleteLearningMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.deleteLearning,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.learnings }),
  })
}

export function useWorkGraphQuery() {
  return useQuery({
    queryKey: qk.workGraph,
    queryFn: api.fetchWorkGraph,
    refetchInterval: STATE_REFETCH_INTERVAL_MS,
  })
}

export function useToolsQuery() {
  return useQuery({ queryKey: qk.tools, queryFn: api.getTools })
}

export function useCreateLearningMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: LearningInputT) => api.createLearning(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.learnings }),
  })
}

export function useExecutionGraphQuery(root?: string | null) {
  return useQuery({
    queryKey: qk.executionGraph(root),
    queryFn: () => api.getExecutionGraph(root),
    refetchInterval: STATE_REFETCH_INTERVAL_MS,
  })
}


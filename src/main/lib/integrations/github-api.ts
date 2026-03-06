import { decryptToken, getIntegration } from "./oauth"

interface GitHubEvent {
  id: string
  type: string
  created_at: string
  payload: any
  repo: { name: string }
  actor: { login: string }
}

interface GitHubWorkflowRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  html_url: string
  created_at: string
  head_branch: string
  repository: { full_name: string }
}

export class GitHubAPI {
  private token: string
  private etags: Map<string, string> = new Map()

  constructor(encryptedToken: string) {
    this.token = decryptToken(encryptedToken)
  }

  static fromIntegration(): GitHubAPI | null {
    const integration = getIntegration("github")
    if (!integration) return null
    return new GitHubAPI(integration.accessToken)
  }

  private async request<T>(url: string, options?: RequestInit): Promise<{ data: T; status: number; headers: Headers }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "AskCodi-Desktop",
    }

    // Add ETag for conditional requests
    const etag = this.etags.get(url)
    if (etag) {
      headers["If-None-Match"] = etag
    }

    const response = await fetch(url, {
      ...options,
      headers: { ...headers, ...options?.headers },
    })

    // Store ETag for next request
    const newEtag = response.headers.get("etag")
    if (newEtag) {
      this.etags.set(url, newEtag)
    }

    if (response.status === 304) {
      return { data: [] as unknown as T, status: 304, headers: response.headers }
    }

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    return { data, status: response.status, headers: response.headers }
  }

  getRateLimit(headers: Headers): { remaining: number; reset: Date } {
    return {
      remaining: parseInt(headers.get("x-ratelimit-remaining") || "5000", 10),
      reset: new Date(parseInt(headers.get("x-ratelimit-reset") || "0", 10) * 1000),
    }
  }

  async getRepoEvents(owner: string, repo: string, page = 1): Promise<{ events: GitHubEvent[]; rateLimit: { remaining: number; reset: Date } }> {
    const url = `https://api.github.com/repos/${owner}/${repo}/events?per_page=30&page=${page}`
    const { data, headers } = await this.request<GitHubEvent[]>(url)
    return { events: data, rateLimit: this.getRateLimit(headers) }
  }

  async getFailedWorkflowRuns(owner: string, repo: string, since?: string): Promise<GitHubWorkflowRun[]> {
    let url = `https://api.github.com/repos/${owner}/${repo}/actions/runs?status=failure&per_page=10`
    if (since) {
      url += `&created=${encodeURIComponent(`>=${since}`)}`
    }
    const { data } = await this.request<{ workflow_runs: GitHubWorkflowRun[] }>(url)
    return data.workflow_runs
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<any> {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`
    const { data } = await this.request(url)
    return data
  }

  async getIssue(owner: string, repo: string, number: number): Promise<any> {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${number}`
    const { data } = await this.request(url)
    return data
  }

  async postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`
    await this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    })
  }

  async getUserRepos(): Promise<
    Array<{
      full_name: string
      name: string
      owner: { login: string }
      html_url: string
      description: string | null
      private: boolean
      default_branch: string
      language: string | null
      stargazers_count: number
      updated_at: string
    }>
  > {
    const url = "https://api.github.com/user/repos?per_page=100&sort=updated"
    const { data } = await this.request<
      Array<{
        full_name: string
        name: string
        owner: { login: string }
        html_url: string
        description: string | null
        private: boolean
        default_branch: string
        language: string | null
        stargazers_count: number
        updated_at: string
      }>
    >(url)
    return data
  }

  async listIssues(
    owner: string,
    repo: string,
    state: string = "open",
    page: number = 1,
  ): Promise<
    Array<{
      number: number
      title: string
      body: string | null
      state: string
      labels: Array<{ id: number; name: string; color: string }>
      user: { login: string; avatar_url: string }
      html_url: string
      created_at: string
      updated_at: string
    }>
  > {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=${state}&per_page=30&page=${page}`
    const { data } = await this.request<
      Array<{
        number: number
        title: string
        body: string | null
        state: string
        labels: Array<{ id: number; name: string; color: string }>
        user: { login: string; avatar_url: string }
        html_url: string
        created_at: string
        updated_at: string
      }>
    >(url)
    return data
  }

  async listPullRequests(
    owner: string,
    repo: string,
    state: string = "open",
    page: number = 1,
  ): Promise<
    Array<{
      number: number
      title: string
      body: string | null
      state: string
      user: { login: string; avatar_url: string }
      html_url: string
      draft: boolean
      created_at: string
      updated_at: string
      head: { ref: string; sha: string }
      base: { ref: string; sha: string }
    }>
  > {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=${state}&per_page=30&page=${page}`
    const { data } = await this.request<
      Array<{
        number: number
        title: string
        body: string | null
        state: string
        user: { login: string; avatar_url: string }
        html_url: string
        draft: boolean
        created_at: string
        updated_at: string
        head: { ref: string; sha: string }
        base: { ref: string; sha: string }
      }>
    >(url)
    return data
  }

  async getIssueComments(
    owner: string,
    repo: string,
    number: number,
  ): Promise<
    Array<{
      id: number
      body: string
      user: { login: string; avatar_url: string }
      created_at: string
    }>
  > {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`
    const { data } = await this.request<
      Array<{
        id: number
        body: string
        user: { login: string; avatar_url: string }
        created_at: string
      }>
    >(url)
    return data
  }

  private async requestText(url: string, options?: RequestInit): Promise<string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "User-Agent": "AskCodi-Desktop",
    }

    const response = await fetch(url, {
      ...options,
      headers: { ...headers, ...options?.headers },
    })

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`)
    }

    return response.text()
  }

  async getPullRequestDiff(owner: string, repo: string, number: number): Promise<string> {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`
    return this.requestText(url, {
      headers: { Accept: "application/vnd.github.v3.diff" },
    })
  }
}

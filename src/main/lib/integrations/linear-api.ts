import { decryptToken, getIntegration } from "./oauth"

export class LinearAPI {
  private token: string

  constructor(encryptedToken: string) {
    this.token = decryptToken(encryptedToken)
  }

  static fromIntegration(): LinearAPI | null {
    const integration = getIntegration("linear")
    console.log("[LinearAPI] fromIntegration:", integration ? `found (user: ${integration.platformUsername})` : "not found")
    if (!integration) return null
    return new LinearAPI(integration.accessToken)
  }

  private async graphql<T>(query: string, variables?: Record<string, any>): Promise<T> {
    console.log("[LinearAPI] GraphQL request:", { query: query.trim().slice(0, 80) + "...", variables })
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.token,
      },
      body: JSON.stringify({ query, variables }),
    })

    if (!response.ok) {
      const body = await response.text()
      console.error("[LinearAPI] HTTP error:", response.status, response.statusText, body)
      throw new Error(`Linear API error: ${response.status} ${response.statusText}`)
    }

    const result = await response.json()
    if (result.errors) {
      console.error("[LinearAPI] GraphQL errors:", JSON.stringify(result.errors))
      throw new Error(`Linear GraphQL error: ${result.errors[0]?.message || "Unknown error"}`)
    }

    console.log("[LinearAPI] Response data keys:", Object.keys(result.data || {}))
    return result.data
  }

  async getRecentIssues(since: string, limit = 50): Promise<any[]> {
    const data = await this.graphql<any>(`
      query($since: DateTime!, $limit: Int!) {
        issues(
          filter: { updatedAt: { gte: $since } }
          first: $limit
          orderBy: updatedAt
        ) {
          nodes {
            id
            identifier
            title
            url
            state { name }
            assignee { name email }
            labels { nodes { name } }
            createdAt
            updatedAt
            creator { name email }
            team { key name }
          }
        }
      }
    `, { since, limit })
    return data.issues?.nodes || []
  }

  async getRecentComments(since: string, limit = 50): Promise<any[]> {
    const data = await this.graphql<any>(`
      query($since: DateTime!, $limit: Int!) {
        comments(
          filter: { updatedAt: { gte: $since } }
          first: $limit
          orderBy: updatedAt
        ) {
          nodes {
            id
            body
            url
            createdAt
            updatedAt
            user { name email }
            issue {
              id
              identifier
              title
              url
              team { key name }
            }
          }
        }
      }
    `, { since, limit })
    return data.comments?.nodes || []
  }

  async postComment(issueId: string, body: string): Promise<void> {
    await this.graphql(`
      mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
        }
      }
    `, { issueId, body })
  }

  async getViewer(): Promise<{ id: string; name: string; email: string }> {
    const data = await this.graphql<any>("{ viewer { id name email } }")
    return data.viewer
  }

  async getTeams(): Promise<any[]> {
    console.log("[LinearAPI] getTeams called")
    const data = await this.graphql<any>(`
      {
        teams {
          nodes {
            id
            key
            name
          }
        }
      }
    `)
    const teams = data.teams?.nodes || []
    console.log("[LinearAPI] getTeams result:", teams.length, "teams", teams.map((t: any) => `${t.key}:${t.name}`))
    return teams
  }

  async getProjects(teamId?: string): Promise<any[]> {
    console.log("[LinearAPI] getProjects called:", { teamId })
    if (teamId) {
      const data = await this.graphql<any>(`
        query($teamId: String!) {
          team(id: $teamId) {
            projects {
              nodes {
                id
                name
              }
            }
          }
        }
      `, { teamId })
      const projects = data.team?.projects?.nodes || []
      console.log("[LinearAPI] getProjects result (filtered):", projects.length, "projects")
      return projects
    }

    const data = await this.graphql<any>(`
      {
        projects(first: 50) {
          nodes {
            id
            name
          }
        }
      }
    `)
    const projects = data.projects?.nodes || []
    console.log("[LinearAPI] getProjects result (all):", projects.length, "projects")
    return projects
  }

  async getTeamIssues(teamId?: string, projectId?: string, limit = 50): Promise<any[]> {
    console.log("[LinearAPI] getTeamIssues called:", { teamId, projectId, limit })
    const filters: string[] = []
    const variables: Record<string, any> = { limit }
    const varDefs: string[] = ["$limit: Int!"]

    if (teamId) {
      filters.push("team: { id: { eq: $teamId } }")
      variables.teamId = teamId
      varDefs.push("$teamId: ID!")
    }

    if (projectId) {
      filters.push("project: { id: { eq: $projectId } }")
      variables.projectId = projectId
      varDefs.push("$projectId: ID!")
    }

    const filterClause = filters.length > 0 ? `filter: { ${filters.join(", ")} },` : ""
    console.log("[LinearAPI] getTeamIssues query:", { filterClause, varDefs, variables })

    const data = await this.graphql<any>(`
      query(${varDefs.join(", ")}) {
        issues(
          ${filterClause}
          first: $limit
          orderBy: updatedAt
        ) {
          nodes {
            id
            identifier
            title
            url
            description
            priority
            priorityLabel
            state { name type color }
            assignee { name }
            labels { nodes { name color } }
            createdAt
            updatedAt
          }
        }
      }
    `, variables)
    const issues = data.issues?.nodes || []
    console.log("[LinearAPI] getTeamIssues result:", issues.length, "issues", issues.slice(0, 3).map((i: any) => `${i.identifier}: ${i.title}`))
    return issues
  }

  async getIssueDetail(issueId: string): Promise<any> {
    const data = await this.graphql<any>(`
      query($issueId: ID!) {
        issue(id: $issueId) {
          id
          identifier
          title
          url
          description
          priority
          priorityLabel
          state { name type color }
          assignee { name }
          labels { nodes { name color } }
          comments { nodes { id body createdAt user { name } } }
          createdAt
          updatedAt
        }
      }
    `, { issueId })
    return data.issue
  }
}

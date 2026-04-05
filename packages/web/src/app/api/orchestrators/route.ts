import { type NextRequest, NextResponse } from "next/server";
import { generateOrchestratorPrompt } from "@composio/ao-core";
import { getServices } from "@/lib/services";
import { validateIdentifier, validateConfiguredProject, validateString } from "@/lib/validation";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const projectErr = validateIdentifier(body.projectId, "projectId");
  if (projectErr) {
    return NextResponse.json({ error: projectErr }, { status: 400 });
  }

  try {
    const { config, sessionManager } = await getServices();
    const projectId = body.projectId as string;
    const projectErr = validateConfiguredProject(config.projects, projectId);
    if (projectErr) {
      return NextResponse.json({ error: projectErr }, { status: 404 });
    }
    const project = config.projects[projectId];

    const agentErr = body.agent != null ? validateString(body.agent, "agent", 255) : null;
    if (agentErr) {
      return NextResponse.json({ error: agentErr }, { status: 400 });
    }
    const agent = typeof body.agent === "string" ? body.agent : undefined;
    const systemPrompt = generateOrchestratorPrompt({ config, projectId, project });
    const session = await sessionManager.spawnOrchestrator({ projectId, systemPrompt, agent });

    return NextResponse.json(
      {
        orchestrator: {
          id: session.id,
          projectId,
          projectName: project.name,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to spawn orchestrator" },
      { status: 500 },
    );
  }
}

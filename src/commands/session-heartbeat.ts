import { ThreadloopError, createInvalidArgumentError } from '../contracts/errors.js';
import { HEARTBEAT_SOURCES, type HeartbeatSource } from '../domain/types.js';
import { heartbeatSession } from '../services/session-service.js';
import { toSessionId, type CommandContext, type JsonOption, type SessionOption, writeCommandSuccess } from './runtime.js';

interface SessionHeartbeatOptions extends JsonOption, SessionOption {
  source?: string;
}

export async function sessionHeartbeatCommand(context: CommandContext, options: SessionHeartbeatOptions) {
  const sessionId = toSessionId(options);
  if (!sessionId) {
    throw new ThreadloopError('SESSION_REQUIRED', 'A session id is required for this command.', {
      details: { hint: 'Pass --session <id>.' },
    });
  }

  const source = options.source?.trim();
  if (source && !HEARTBEAT_SOURCES.includes(source as HeartbeatSource)) {
    throw createInvalidArgumentError(`Heartbeat source must be one of: ${HEARTBEAT_SOURCES.join(', ')}`, {
      source,
    });
  }

  const result = await heartbeatSession({
    cwd: context.cwd,
    sessionId,
    source: source as HeartbeatSource | undefined,
  });

  writeCommandSuccess(context, {
    text: [
      `Heartbeat recorded for ${result.session.id}`,
      `Branch: ${result.session.branch}`,
      `Head: ${result.session.headSha}`,
    ],
    data: {
      session_id: result.session.id,
      task: result.task,
      session: {
        id: result.session.id,
        branch: result.session.branch,
        head_sha: result.session.headSha,
        last_heartbeat_at: result.session.lastHeartbeatAt,
        last_heartbeat_source: result.session.lastHeartbeatSource,
      },
    },
  });
}

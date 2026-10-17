import { useEffect, useRef, useState } from 'react';
import type { QueueEventMessage } from '@queueforge/shared';
import { API_BASE } from '@/services/api';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting';

/**
 * Subscribes to the API's Server-Sent Events stream.
 *
 * EventSource reconnects on its own and sends Last-Event-ID, so the API replays buffered events
 * missed during short gaps. Events are still only hints: `onOpen` fires on every (re)connect so
 * callers refetch authoritative state from the REST API instead of trusting the stream alone.
 */
export function useEventStream(onEvent: (e: QueueEventMessage) => void, onOpen: () => void): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const handlers = useRef({ onEvent, onOpen });
  useEffect(() => {
    handlers.current = { onEvent, onOpen };
  });

  useEffect(() => {
    const source = new EventSource(`${API_BASE}/api/v1/events`);
    source.onopen = () => {
      setStatus('live');
      handlers.current.onOpen();
    };
    source.onerror = () => setStatus(source.readyState === EventSource.CLOSED ? 'connecting' : 'reconnecting');
    source.addEventListener('queue-event', (msg) => {
      try {
        handlers.current.onEvent(JSON.parse((msg as MessageEvent<string>).data) as QueueEventMessage);
      } catch {
        // Ignore malformed messages.
      }
    });
    return () => source.close();
  }, []);

  return status;
}

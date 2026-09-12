import {
  createEffect, createSignal, onCleanup, Show, For,
} from 'solid-js';
import { Button } from '@kobalte/core/button';
import { Dialog } from '@kobalte/core/dialog';
import type { RoadRatingSubtype, RoadRatingType } from '@vrstevnice/shared';
import {
  error as plannerError, planner, regenerateRoute, setError as setPlannerError,
} from './appStore';
import {
  closeRoadRatingModal,
  deleteRoadRating,
  refreshRoadRatings,
  roadRatingSelection,
  saveRoadRating,
} from './roadRatingsStore';

const reasons: Record<RoadRatingType, { value: RoadRatingSubtype; label: string }[]> = {
  prefer: [
    { value: 'nice', label: '✨ Pěkná' },
    { value: 'safe', label: '🛡️ Bezpečná' },
    { value: 'fast', label: '⚡ Rychlá' },
  ],
  demote: [
    { value: 'dangerous', label: '⚠️ Nebezpečná' },
    { value: 'unpassable', label: '🚫 Nepřejezdná' },
    { value: 'bad_terrain', label: '🌧️ Špatný terén' },
  ],
};

function failureMessage(error: object | string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Hodnocení se nepodařilo uložit. Zkuste to prosím znovu.';
}

export default function RoadRatingModal() {
  const [type, setType] = createSignal<RoadRatingType>('prefer');
  const [subtypes, setSubtypes] = createSignal<RoadRatingSubtype[]>([]);
  const [comment, setComment] = createSignal('');
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal<string | null>(null);
  let successCloseTimer: ReturnType<typeof setTimeout> | null = null;

  createEffect(() => {
    const selection = roadRatingSelection();
    if (!selection) return;
    if (successCloseTimer) {
      clearTimeout(successCloseTimer);
      successCloseTimer = null;
    }
    setType(selection.mine?.type ?? 'prefer');
    setSubtypes(selection.mine?.subtypes ?? []);
    setComment(selection.mine?.comment ?? '');
    setError(null);
    setSuccess(null);
    setPending(false);
  });

  onCleanup(() => {
    if (successCloseTimer) clearTimeout(successCloseTimer);
  });

  function chooseType(next: RoadRatingType) {
    setType(next);
    setSubtypes([]);
    setError(null);
  }

  function toggleReason(reason: RoadRatingSubtype) {
    setSubtypes((current) => (
      current.includes(reason) ? current.filter((item) => item !== reason) : [...current, reason]
    ));
  }

  function showSuccess(message: string) {
    if (successCloseTimer) clearTimeout(successCloseTimer);
    setSuccess(message);
    successCloseTimer = setTimeout(() => {
      successCloseTimer = null;
      closeRoadRatingModal();
    }, 1200);
  }

  async function afterChange(message: string, routeFailureMessage: string) {
    refreshRoadRatings();
    if (!planner.route || !planner.useRoadRatings) {
      showSuccess(message);
      return;
    }
    try {
      setPlannerError(null);
      await regenerateRoute();
      if (plannerError()) {
        setError(`${routeFailureMessage}: ${plannerError()}`);
        return;
      }
      showSuccess(message);
    } catch {
      setError(routeFailureMessage);
    }
  }

  async function save() {
    const selection = roadRatingSelection();
    if (!selection || pending()) return;
    if (subtypes().length === 0) {
      setError('Vyberte alespoň jeden důvod.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await saveRoadRating({
        wayId: selection.wayId,
        name: selection.name ?? undefined,
        type: type(),
        subtypes: subtypes(),
        comment: comment().trim() || undefined,
      });
      await afterChange(
        'Hodnocení uloženo.',
        'Hodnocení bylo uloženo, ale přepočítání trasy se nezdařilo.',
      );
    } catch (saveError) {
      setError(failureMessage(saveError as object));
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    const selection = roadRatingSelection();
    if (!selection || pending()) return;
    setPending(true);
    setError(null);
    try {
      await deleteRoadRating(selection.wayId);
      await afterChange(
        'Hodnocení zrušeno.',
        'Hodnocení bylo zrušeno, ale přepočítání trasy se nezdařilo.',
      );
    } catch (deleteError) {
      setError(failureMessage(deleteError as object));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={Boolean(roadRatingSelection())}
      onOpenChange={(open) => !open && closeRoadRatingModal()}
    >
      <Dialog.Portal>
        <Dialog.Overlay class="road-rating-overlay" />
        <Dialog.Content class="road-rating-modal">
          <Dialog.Title class="road-rating-title">Hodnocení cesty</Dialog.Title>
          <Dialog.Description class="road-rating-road">
            {roadRatingSelection()?.name ?? 'Vybraná cesta'}
          </Dialog.Description>
          <p class="road-rating-note">Ovlivní aktuální i budoucí plánování</p>

          <div class="road-rating-types" role="group" aria-label="Typ hodnocení">
            <Button
              class="road-rating-type"
              classList={{ selected: type() === 'prefer' }}
              aria-pressed={type() === 'prefer'}
              disabled={pending() || Boolean(success())}
              onClick={() => chooseType('prefer')}
            >👍 Upřednostnit tuto cestu</Button>
            <Button
              class="road-rating-type"
              classList={{ selected: type() === 'demote' }}
              aria-pressed={type() === 'demote'}
              disabled={pending() || Boolean(success())}
              onClick={() => chooseType('demote')}
            >👎 Zkusit se vyhnout</Button>
          </div>

          <label class="road-rating-comment-label" for="road-rating-comment">
            Komentář <span>(volitelné)</span>
          </label>
          <textarea
            id="road-rating-comment"
            class="road-rating-comment"
            maxlength="1000"
            rows="3"
            value={comment()}
            disabled={pending() || Boolean(success())}
            onInput={(event) => setComment(event.currentTarget.value)}
            placeholder="Co by měli ostatní cyklisté vědět?"
          />

          <div class="road-rating-reasons" role="group" aria-label="Důvody hodnocení">
            <For each={reasons[type()]}>{(reason) => (
              <Button
                class="road-rating-reason"
                classList={{ selected: subtypes().includes(reason.value) }}
                aria-pressed={subtypes().includes(reason.value)}
                disabled={pending() || Boolean(success())}
                onClick={() => toggleReason(reason.value)}
              >{reason.label}</Button>
            )}</For>
          </div>

          <Show when={error()}>{(message) => (
            <p class="road-rating-error" role="alert">{message()}</p>
          )}</Show>
          <Show when={success()}>{(message) => (
            <p class="road-rating-success" role="status">{message()}</p>
          )}</Show>

          <div class="road-rating-actions">
            <Show when={roadRatingSelection()?.mine}>
              <Button
                class="btn btn-ghost road-rating-remove"
                disabled={pending() || Boolean(success())}
                onClick={remove}
              >
                Zrušit moje hodnocení
              </Button>
            </Show>
            <div class="road-rating-actions-main">
              <Button class="btn btn-ghost" disabled={pending()} onClick={closeRoadRatingModal}>
                Zrušit
              </Button>
              <Button
                class="btn btn-primary"
                disabled={pending() || Boolean(success())}
                onClick={save}
              >
                {pending() ? 'Ukládám…' : 'Uložit hodnocení'}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}

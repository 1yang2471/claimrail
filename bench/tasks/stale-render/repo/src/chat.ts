export function Bubble({ mine, text }: { mine: boolean; text: string }) {
  return `<div class="bubble ${mine ? 'mine' : 'other'}">${text}</div>`;
}
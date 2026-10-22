/**
 * Fill a count into a sentence so "1 files" never reaches the screen.
 *
 * The template keeps both forms in one translatable string:
 *   `{count}`      the number (or `{name}` when a name is passed)
 *   `[s]`          nothing for one, "s" for any other count     ("{count} file[s]")
 *   `[was|were]`   the first form for one, the second otherwise ("[was|were] kept")
 */
export function plural(template: string, count: number, name = 'count'): string {
    return template
        .split(`{${name}}`).join(String(count))
        .replace(/\[([^\]|]*)(?:\|([^\]]*))?\]/g, (_all, one: string, other?: string) => {
            if (other === undefined) return count === 1 ? '' : one;
            return count === 1 ? one : other;
        });
}

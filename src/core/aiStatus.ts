/**
 * Where the plugin keeps its own processing mark (`processed` / `pending` / `error`).
 *
 * The default, and the only value that existed before, is the shared `status` property. A user can opt in to
 * `aio-status`, a property only the plugin writes, so a project's `active` and the AI's `processed` never share one
 * field. With the default every output is byte-identical to before: the resolver returns `status`, and
 * `retargetStatusFilter` returns its input unchanged.
 */
export type AiStatusProperty = 'status' | 'aio-status';

/** The plugin-owned property used once the user opts in. */
export const AIO_STATUS_KEY = 'aio-status';

/** The property the mark is read from and written to. Anything but an explicit opt-in is the shared `status`. */
export function aiStatusKey(settings: { aiStatusProperty?: unknown } | null | undefined): AiStatusProperty {
    return settings?.aiStatusProperty === AIO_STATUS_KEY ? AIO_STATUS_KEY : 'status';
}

/** A Bases filter on the shared status that compares it with one of the plugin's marks: `status == "processed"`. */
const STATUS_FILTER = /(?<![\w.-])(?:note\.)?status(\s*(?:==|!=)\s*)"(processed|pending|error)"/g;

/**
 * A dashboard filter retargeted to the property the mark lives in. With `status` the text is returned untouched. With
 * `aio-status`, each `status == "processed"` (also `!=`, and `pending` / `error`) becomes `note["aio-status"] == "processed"`.
 * Bases reads a hyphenated property name only through `note[...]`. Nothing else in the text changes.
 */
export function retargetStatusFilter(text: string, key: AiStatusProperty): string {
    if (key === 'status') return text;
    return text.replace(STATUS_FILTER, (_m, op: string, mark: string) => `note["${AIO_STATUS_KEY}"]${op}"${mark}"`);
}

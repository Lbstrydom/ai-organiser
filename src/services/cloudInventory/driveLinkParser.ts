/**
 * Turn what a person pastes ("share" link, address-bar URL or a bare ID) into a Drive folder ID.
 * Only drive.google.com links and bare IDs are accepted; anything else is refused with a stable
 * code so the wizard can say what to do.
 */
import { Result, ok, err } from '../../core/result';
import { DRIVE_FOLDER_ID_PATTERN } from '../../core/settings';

export function parseDriveFolderInput(input: string): Result<string> {
    const raw = input.trim();
    if (raw === '') return err('drive-link-invalid');
    if (DRIVE_FOLDER_ID_PATTERN.test(raw)) return ok(raw);
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return err('drive-link-invalid');
    }
    if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com') return err('drive-link-invalid');
    const fromPath = /\/folders\/([A-Za-z0-9_-]+)/.exec(url.pathname);
    const candidate = fromPath ? fromPath[1] : url.searchParams.get('id');
    return candidate && DRIVE_FOLDER_ID_PATTERN.test(candidate) ? ok(candidate) : err('drive-link-invalid');
}

import { dictionary } from "@text/index";

import type { Dictionary, TextZone } from "@text/interfaces/textTypes";

/**
 * One zone of the string tree (TRE-116).
 *
 * Not a hook in the React sense — there is one locale and nothing to subscribe
 * to — but the call site is the sibling apps' (`const t = useTranslations("hosts")`),
 * so the day a second locale is wanted, this file changes and no component does.
 */
const useTranslations = <Z extends TextZone>(zone: Z): Dictionary[Z] => dictionary[zone];

export default useTranslations;

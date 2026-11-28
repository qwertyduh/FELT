/**
 * Rooms this tab has just created, so their invite sheet opens once by itself. In memory only: a
 * reload or a later visit does not show it again (the Invite button does).
 */
const codes = new Set<string>();

export const markCreated = (code: string): void => void codes.add(code);
export const isJustCreated = (code: string): boolean => codes.has(code);
export const forgetCreated = (code: string): void => void codes.delete(code);

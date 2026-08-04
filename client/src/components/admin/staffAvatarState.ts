export type StaffAvatarFailureAction =
    | { type: 'error'; avatarUrl: string }
    | { type: 'reset' };

export const nextFailedAvatarUrl = (
    _current: string | null,
    action: StaffAvatarFailureAction,
): string | null => action.type === 'error' ? action.avatarUrl : null;

export const avatarImageVisible = (
    avatarUrl: string | undefined,
    failedAvatarUrl: string | null,
) => Boolean(avatarUrl && avatarUrl !== failedAvatarUrl);

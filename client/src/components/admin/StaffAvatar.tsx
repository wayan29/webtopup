import { useEffect, useReducer } from 'react';
import { avatarImageVisible, nextFailedAvatarUrl } from './staffAvatarState';

type StaffAvatarProps = {
    avatarUrl?: string;
    initials: string;
    alt?: string;
    className: string;
    imageClassName?: string;
};

/**
 * Keeps initials in the DOM underneath the optional image. Failure is React-controlled rather
 * than mutating a React-owned DOM node. A URL change resets the failure so replacement avatars
 * are attempted immediately.
 */
export function StaffAvatar({
    avatarUrl,
    initials,
    alt = '',
    className,
    imageClassName = 'h-full w-full object-cover',
}: StaffAvatarProps) {
    const [failedAvatarUrl, dispatchFailure] = useReducer(nextFailedAvatarUrl, null);

    useEffect(() => {
        dispatchFailure({ type: 'reset' });
    }, [avatarUrl]);

    const showImage = avatarImageVisible(avatarUrl, failedAvatarUrl);

    return (
        <div className={className} role="img" aria-label={alt || 'Avatar'}>
            <span aria-hidden="true">{initials}</span>
            {showImage ? (
                <img
                    src={avatarUrl}
                    alt=""
                    aria-hidden="true"
                    className={`absolute inset-0 ${imageClassName}`}
                    onError={() => dispatchFailure({ type: 'error', avatarUrl: avatarUrl! })}
                />
            ) : null}
        </div>
    );
}

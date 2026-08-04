interface OperatorIconProps {
    icon?: string;
    fallback?: string;
    size?: 'sm' | 'md' | 'lg' | 'xl';
    className?: string;
}

const sizeClasses = {
    sm: 'w-5 h-5 text-sm',
    md: 'w-8 h-8 text-base',
    lg: 'w-10 h-10 text-lg',
    xl: 'w-12 h-12 text-xl'
};

function isImageUrl(str: string): boolean {
    if (!str) return false;
    return str.startsWith('http://') || 
           str.startsWith('https://') || 
           str.startsWith('data:image/') ||
           str.startsWith('/');
}

export default function OperatorIcon({ icon, fallback = '📱', size = 'md', className = '' }: OperatorIconProps) {
    const sizeClass = sizeClasses[size];
    
    if (!icon) {
        return <span className={className}>{fallback}</span>;
    }

    if (isImageUrl(icon)) {
        return (
            <img 
                src={icon} 
                alt="icon" 
                className={`${sizeClass} object-cover rounded ${className}`}
            />
        );
    }

    return <span className={className}>{icon}</span>;
}

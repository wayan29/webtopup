import { useSearchParams } from 'react-router-dom';

import { parseSellerCenterSection } from '../../lib/digiflazzSellerCenter';

/**
 * Canonical Digiflazz Seller Center shell. The full section content lands in
 * the Seller Center UI task; the route and shell identity exist so legacy
 * redirects resolve to a live canonical surface.
 */
const DigiflazzSellerCenter = () => {
    const [searchParams] = useSearchParams();
    const section = parseSellerCenterSection(searchParams.get('section'));

    return (
        <div className="space-y-4">
            <h2 className="text-lg font-semibold ui-text-primary">Digiflazz Seller Center</h2>
            <p className="text-sm ui-text-muted">Bagian aktif: {section}</p>
        </div>
    );
};

export default DigiflazzSellerCenter;

import { useEffect, useState } from 'react';
import { apiV2 } from '../../api';
import {
    Plus,
    Edit,
    Trash2,
    TestTube,
    RefreshCw,
    BarChart3,
    Check,
    X,
    Loader
} from 'lucide-react';

interface Vendor {
    _id: string;
    name: string;
    apiBaseUrl: string;
    lowBalanceThreshold?: number;
    config: {
        username?: string;
        apiKey?: string;
    };
    status: boolean;
    createdAt: string;
}

interface VendorStats {
    totalProducts: number;
    activeProducts: number;
    categories: string[];
    status: boolean;
}

export default function Vendors() {
    const [vendors, setVendors] = useState<Vendor[]>([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [showStatsModal, setShowStatsModal] = useState(false);
    const [editingVendor, setEditingVendor] = useState<Vendor | null>(null);
    const [stats, setStats] = useState<VendorStats | null>(null);
    const [testingVendorId, setTestingVendorId] = useState<string | null>(null);
    const [syncingVendorId, setSyncingVendorId] = useState<string | null>(null);

    const [formData, setFormData] = useState({
        name: '',
        apiBaseUrl: '',
        username: '',
        apiKey: '',
        lowBalanceThreshold: '',
        status: true
    });

    const fetchVendors = async () => {
        try {
            setLoading(true);
            const res = await apiV2
                .get('/vendors/admin/all');
            setVendors(res.data);
        } catch (error) {
            console.error('Failed to fetch vendors:', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchVendors();
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        try {
            const payload = {
                name: formData.name,
                apiBaseUrl: formData.apiBaseUrl,
                config: {
                    username: formData.username,
                    apiKey: formData.apiKey
                },
                lowBalanceThreshold: Number(formData.lowBalanceThreshold || 0),
                status: formData.status
            };

            if (editingVendor) {
                await apiV2
                    .put(`/vendors/${editingVendor._id}`, payload);
            } else {
                await apiV2
                    .post('/vendors', payload);
            }

            setShowModal(false);
            resetForm();
            fetchVendors();
        } catch (error: any) {
            alert(error.response?.data?.message || 'Failed to save vendor');
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm('Are you sure you want to delete this vendor?')) return;

        try {
            await apiV2
                .delete(`/vendors/${id}`);
            fetchVendors();
        } catch (error: any) {
            alert(error.response?.data?.message || 'Failed to delete vendor');
        }
    };

    const handleTest = async (id: string) => {
        setTestingVendorId(id);
        try {
            const res = await apiV2.post(`/vendors/${id}/test`);
            const data = res.data;
            if (data.success) {
                alert(`✅ Connection successful!\nBalance: Rp ${data.balance.toLocaleString('id-ID')}`);
            } else {
                alert(`❌ ${data.message}`);
            }
        } catch (error: any) {
            alert('❌ Test failed: ' + (error.response?.data?.message || error.message));
        } finally {
            setTestingVendorId(null);
        }
    };

    const handleSync = async (id: string) => {
        if (!confirm('Sync products from this vendor? This may take a while.')) return;

        setSyncingVendorId(id);
        try {
            const res = await apiV2.post(`/vendors/${id}/sync`);
            alert(`✅ ${res.data.message}`);
            fetchVendors();
        } catch (error: any) {
            alert('❌ Sync failed: ' + (error.response?.data?.message || error.message));
        } finally {
            setSyncingVendorId(null);
        }
    };

    const handleViewStats = async (id: string) => {
        try {
            const res = await apiV2
                .get(`/vendors/${id}/stats`);
            setStats(res.data);
            setShowStatsModal(true);
        } catch (error: any) {
            alert('Failed to fetch stats: ' + (error.response?.data?.message || error.message));
        }
    };

    const handleEdit = (vendor: Vendor) => {
        setEditingVendor(vendor);
        setFormData({
            name: vendor.name,
            apiBaseUrl: vendor.apiBaseUrl,
            username: vendor.config.username || '',
            apiKey: vendor.config.apiKey || '',
            lowBalanceThreshold: String(vendor.lowBalanceThreshold || ''),
            status: vendor.status
        });
        setShowModal(true);
    };

    const resetForm = () => {
        setEditingVendor(null);
        setFormData({
            name: '',
            apiBaseUrl: '',
            username: '',
            apiKey: '',
            lowBalanceThreshold: '',
            status: true
        });
    };

    const handleAddNew = () => {
        resetForm();
        setShowModal(true);
    };

    return (
        <div className="space-y-6">
            <div className="ui-panel-muted flex flex-wrap gap-2 rounded-xl border ui-border p-4">
                <button
                    onClick={handleAddNew}
                    className="ui-accent-solid flex items-center gap-2 rounded-lg px-4 py-2 transition-colors"
                >
                    <Plus className="w-4 h-4" />
                    Add Vendor
                </button>
            </div>

            {/* Vendors List */}
            <div className="ui-panel-muted overflow-hidden rounded-lg border ui-border shadow-sm">
                {loading ? (
                    <div className="p-12 text-center ui-text-muted">Loading vendors...</div>
                ) : vendors.length === 0 ? (
                    <div className="p-12 text-center ui-text-muted">
                        <p className="mb-4">No vendors found</p>
                        <button
                            onClick={handleAddNew}
                            className="ui-accent-text underline hover:text-[var(--ui-accent-strong)]"
                        >
                            Add your first vendor
                        </button>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-[var(--ui-border)]">
                            <thead className="ui-panel">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-medium ui-text-muted uppercase">
                                        Vendor
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium ui-text-muted uppercase">
                                        API URL
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium ui-text-muted uppercase">
                                        Status
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium ui-text-muted uppercase">
                                        Low Balance
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium ui-text-muted uppercase">
                                        Created
                                    </th>
                                    <th className="px-6 py-3 text-right text-xs font-medium ui-text-muted uppercase">
                                        Actions
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--ui-border)]">
                                {vendors.map((vendor) => (
                                    <tr key={vendor._id} className="hover:bg-[var(--ui-card-bg)]">
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <div className="text-sm font-medium ui-text">
                                                {vendor.name}
                                            </div>
                                            {vendor.config.username && (
                                                <div className="text-sm ui-text-muted">
                                                    @{vendor.config.username}
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <div className="text-sm ui-text">{vendor.apiBaseUrl}</div>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            {vendor.status ? (
                                                <span className="inline-flex rounded-full border px-2 text-xs font-semibold leading-5 ui-success-chip">
                                                    Active
                                                </span>
                                            ) : (
                                                <span className="inline-flex rounded-full border px-2 text-xs font-semibold leading-5 ui-danger-chip">
                                                    Inactive
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm ui-text-muted">
                                            {vendor.lowBalanceThreshold ? `Rp ${vendor.lowBalanceThreshold.toLocaleString('id-ID')}` : 'Off'}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm ui-text-muted">
                                            {new Date(vendor.createdAt).toLocaleDateString('id-ID')}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                            <div className="flex items-center justify-end gap-2">
                                                <button
                                                    onClick={() => handleViewStats(vendor._id)}
                                                    className="ui-accent-text hover:text-[var(--ui-accent-strong)]"
                                                    title="View Stats"
                                                >
                                                    <BarChart3 className="w-5 h-5" />
                                                </button>
                                                <button
                                                    onClick={() => handleTest(vendor._id)}
                                                    disabled={testingVendorId === vendor._id}
                                                    className="ui-info-text hover:brightness-125 disabled:opacity-50"
                                                    title="Test Connection"
                                                >
                                                    {testingVendorId === vendor._id ? (
                                                        <Loader className="w-5 h-5 animate-spin" />
                                                    ) : (
                                                        <TestTube className="w-5 h-5" />
                                                    )}
                                                </button>
                                                <button
                                                    onClick={() => handleSync(vendor._id)}
                                                    disabled={syncingVendorId === vendor._id}
                                                    className="ui-success-text hover:brightness-125 disabled:opacity-50"
                                                    title="Sync Products"
                                                >
                                                    {syncingVendorId === vendor._id ? (
                                                        <Loader className="w-5 h-5 animate-spin" />
                                                    ) : (
                                                        <RefreshCw className="w-5 h-5" />
                                                    )}
                                                </button>
                                                <button
                                                    onClick={() => handleEdit(vendor)}
                                                    className="ui-accent-text hover:text-[var(--ui-accent-strong)]"
                                                    title="Edit"
                                                >
                                                    <Edit className="w-5 h-5" />
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(vendor._id)}
                                                    className="ui-danger-text hover:brightness-125"
                                                    title="Delete"
                                                >
                                                    <Trash2 className="w-5 h-5" />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Add/Edit Vendor Modal */}
            {showModal && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                    <div className="ui-panel-muted w-full max-w-md rounded-lg border ui-border shadow-xl">
                        <div className="p-6">
                            <h2 className="mb-4 text-xl font-bold ui-text">
                                {editingVendor ? 'Edit Vendor' : 'Add New Vendor'}
                            </h2>
                            <form onSubmit={handleSubmit} className="space-y-4">
                                <div>
                                    <label className="mb-1 block text-sm font-medium ui-text-muted">
                                        Vendor Name
                                    </label>
                                    <input
                                        type="text"
                                        value={formData.name}
                                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                        className="w-full rounded-lg border ui-field px-3 py-2 focus:border-[var(--ui-accent)] focus:ring-2 focus:ring-[var(--ui-accent-soft)]"
                                        placeholder="e.g., Digiflazz"
                                        required
                                    />
                                </div>

                                <div>
                                    <label className="mb-1 block text-sm font-medium ui-text-muted">
                                        API Base URL
                                    </label>
                                    <input
                                        type="url"
                                        value={formData.apiBaseUrl}
                                        onChange={(e) => setFormData({ ...formData, apiBaseUrl: e.target.value })}
                                        className="w-full rounded-lg border ui-field px-3 py-2 focus:border-[var(--ui-accent)] focus:ring-2 focus:ring-[var(--ui-accent-soft)]"
                                        placeholder="https://api.digiflazz.com/v1"
                                        required
                                    />
                                </div>

                                <div>
                                    <label className="mb-1 block text-sm font-medium ui-text-muted">
                                        Username
                                    </label>
                                    <input
                                        type="text"
                                        value={formData.username}
                                        onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                                        className="w-full rounded-lg border ui-field px-3 py-2 focus:border-[var(--ui-accent)] focus:ring-2 focus:ring-[var(--ui-accent-soft)]"
                                        placeholder="Vendor username"
                                    />
                                </div>

                                <div>
                                    <label className="mb-1 block text-sm font-medium ui-text-muted">
                                        API Key
                                    </label>
                                    <input
                                        type="password"
                                        value={formData.apiKey}
                                        onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                                        className="w-full rounded-lg border ui-field px-3 py-2 focus:border-[var(--ui-accent)] focus:ring-2 focus:ring-[var(--ui-accent-soft)]"
                                        placeholder="Vendor API key"
                                    />
                                </div>

                                <div>
                                    <label className="mb-1 block text-sm font-medium ui-text-muted">
                                        Low Balance Threshold
                                    </label>
                                    <input
                                        type="number"
                                        min="0"
                                        value={formData.lowBalanceThreshold}
                                        onChange={(e) => setFormData({ ...formData, lowBalanceThreshold: e.target.value })}
                                        className="w-full rounded-lg border ui-field px-3 py-2 focus:border-[var(--ui-accent)] focus:ring-2 focus:ring-[var(--ui-accent-soft)]"
                                        placeholder="0 = alert off"
                                    />
                                    <p className="mt-1 text-xs ui-text-muted">Alert Vendor Health aktif jika saldo vendor di bawah nominal ini.</p>
                                </div>

                                <div className="flex items-center">
                                    <input
                                        type="checkbox"
                                        id="status"
                                        checked={formData.status}
                                        onChange={(e) => setFormData({ ...formData, status: e.target.checked })}
                                        className="h-4 w-4 rounded ui-accent-text ui-border focus:ring-[var(--ui-accent)]"
                                    />
                                    <label htmlFor="status" className="ml-2 text-sm ui-text-muted">
                                        Active
                                    </label>
                                </div>

                                <div className="flex gap-3 pt-4">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowModal(false);
                                            resetForm();
                                        }}
                                        className="flex-1 rounded-lg border ui-border px-4 py-2 ui-text-muted hover:bg-[var(--ui-card-muted)]"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="submit"
                                        className="ui-accent-solid flex-1 rounded-lg px-4 py-2"
                                    >
                                        {editingVendor ? 'Update' : 'Create'}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
            )}

            {/* Stats Modal */}
            {showStatsModal && stats && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                    <div className="ui-panel-muted w-full max-w-md rounded-lg border ui-border shadow-xl">
                        <div className="p-6">
                            <div className="flex items-center justify-between mb-4">
                                <h2 className="text-xl font-bold ui-text">Vendor Statistics</h2>
                                <button
                                    onClick={() => setShowStatsModal(false)}
                                    className="ui-text-muted hover:text-[var(--ui-text)]"
                                >
                                    <X className="w-6 h-6" />
                                </button>
                            </div>

                            <div className="space-y-4">
                                <div className="ui-panel rounded-lg border ui-border p-4">
                                    <div className="text-sm ui-text-muted">Total Products</div>
                                    <div className="text-2xl font-bold ui-text">{stats.totalProducts}</div>
                                </div>

                                <div className="ui-panel rounded-lg border ui-border p-4">
                                    <div className="text-sm ui-text-muted">Active Products</div>
                                    <div className="text-2xl font-bold ui-success-text">{stats.activeProducts}</div>
                                </div>

                                <div className="ui-panel rounded-lg border ui-border p-4">
                                    <div className="mb-2 text-sm ui-text-muted">Categories</div>
                                    <div className="flex flex-wrap gap-2">
                                        {stats.categories.map((cat) => (
                                            <span
                                                key={cat}
                                                className="rounded border px-2 py-1 text-xs ui-info-chip"
                                            >
                                                {cat}
                                            </span>
                                        ))}
                                    </div>
                                </div>

                                <div className="ui-panel rounded-lg border ui-border p-4">
                                    <div className="text-sm ui-text-muted">Vendor Status</div>
                                    <div className="flex items-center gap-2 mt-1">
                                        {stats.status ? (
                                            <>
                                                <Check className="h-5 w-5 ui-success-text" />
                                                <span className="font-medium ui-success-text">Active</span>
                                            </>
                                        ) : (
                                            <>
                                                <X className="h-5 w-5 ui-danger-text" />
                                                <span className="font-medium ui-danger-text">Inactive</span>
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <button
                                onClick={() => setShowStatsModal(false)}
                                className="ui-muted-action mt-6 w-full rounded-lg border px-4 py-2"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

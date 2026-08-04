//! Pure pricing helpers for vendor catalog sync.
//!
//! Digiflazz/Tokovoucher pricelists expose **buyer cost**. The storefront sells at
//! membership tiers derived from the global margin settings (percent over cost),
//! not at the inverted 0.98/0.95 "discount from cost" that treated cost as MSRP.

/// Default membership margins when the `margins` settings document is missing.
/// Matches `rust-api/src/routes/margins` setOnInsert defaults.
pub(super) const DEFAULT_MARGIN_BASIC: f64 = 10.0;
pub(super) const DEFAULT_MARGIN_GOLD: f64 = 5.0;
pub(super) const DEFAULT_MARGIN_PLATINUM: f64 = 0.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct MembershipMargins {
    pub basic: f64,
    pub gold: f64,
    pub platinum: f64,
}

impl Default for MembershipMargins {
    fn default() -> Self {
        Self {
            basic: DEFAULT_MARGIN_BASIC,
            gold: DEFAULT_MARGIN_GOLD,
            platinum: DEFAULT_MARGIN_PLATINUM,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct SellPrices {
    pub basic: i64,
    pub gold: i64,
    pub platinum: i64,
}

/// Apply percent-over-cost margins. Negative/NaN margins clamp to 0. Cost clamps to >= 0.
pub(super) fn sell_prices_from_cost(cost: i64, margins: MembershipMargins) -> SellPrices {
    let cost = cost.max(0) as f64;
    let basic_pct = sanitize_margin_percent(margins.basic);
    let gold_pct = sanitize_margin_percent(margins.gold);
    let platinum_pct = sanitize_margin_percent(margins.platinum);
    SellPrices {
        basic: (cost * (1.0 + basic_pct / 100.0)).round() as i64,
        gold: (cost * (1.0 + gold_pct / 100.0)).round() as i64,
        platinum: (cost * (1.0 + platinum_pct / 100.0)).round() as i64,
    }
}

fn sanitize_margin_percent(value: f64) -> f64 {
    if !value.is_finite() || value < 0.0 {
        0.0
    } else {
        value
    }
}

/// Digiflazz category label → public category icon.
pub(super) fn category_icon_for_label(category: &str) -> &'static str {
    let key = category.trim().to_ascii_lowercase();
    match key.as_str() {
        "games" | "games" => "🎮",
        "pulsa" => "📱",
        "data" => "📶",
        "voucher" => "🎫",
        "pln" => "⚡",
        "masa aktif" => "⏳",
        "paket sms & telpon" | "paket sms dan telpon" => "💬",
        "streaming" => "📺",
        "e-money" | "emoney" => "💳",
        _ => "📦",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_margins_mark_up_cost_not_down() {
        let prices = sell_prices_from_cost(10_000, MembershipMargins::default());
        // 10% / 5% / 0% over cost — never cheaper than cost for basic.
        assert_eq!(prices.basic, 11_000);
        assert_eq!(prices.gold, 10_500);
        assert_eq!(prices.platinum, 10_000);
        assert!(prices.basic >= prices.gold);
        assert!(prices.gold >= prices.platinum);
        assert!(prices.platinum >= 10_000);
    }

    #[test]
    fn zero_cost_stays_zero() {
        let prices = sell_prices_from_cost(0, MembershipMargins::default());
        assert_eq!(prices, SellPrices { basic: 0, gold: 0, platinum: 0 });
    }

    #[test]
    fn negative_cost_clamps_to_zero() {
        let prices = sell_prices_from_cost(-50, MembershipMargins::default());
        assert_eq!(prices.basic, 0);
    }

    #[test]
    fn invalid_margin_percent_does_not_discount_below_cost() {
        let prices = sell_prices_from_cost(
            1_000,
            MembershipMargins {
                basic: f64::NAN,
                gold: -20.0,
                platinum: f64::INFINITY,
            },
        );
        assert_eq!(prices.basic, 1_000);
        assert_eq!(prices.gold, 1_000);
        assert_eq!(prices.platinum, 1_000);
    }

    #[test]
    fn legacy_098_discount_formula_is_not_used() {
        // Guard regression: old sync used cost * 0.98 / 0.95 which sold BELOW cost.
        let cost = 100_000_i64;
        let prices = sell_prices_from_cost(cost, MembershipMargins::default());
        assert_ne!(prices.gold, ((cost as f64) * 0.98).floor() as i64);
        assert_ne!(prices.platinum, ((cost as f64) * 0.95).floor() as i64);
        assert!(prices.basic > cost);
    }

    #[test]
    fn category_icons_cover_digiflazz_labels() {
        assert_eq!(category_icon_for_label("Games"), "🎮");
        assert_eq!(category_icon_for_label("Pulsa"), "📱");
        assert_eq!(category_icon_for_label("Data"), "📶");
        assert_eq!(category_icon_for_label("Voucher"), "🎫");
        assert_eq!(category_icon_for_label("PLN"), "⚡");
        assert_eq!(category_icon_for_label("unknown-xyz"), "📦");
    }
}

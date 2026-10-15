/// Current date in Asia/Jakarta as `YYYY-MM-DD`.
pub(super) fn jakarta_today_key() -> String {
    let jakarta = chrono::Utc::now()
        .with_timezone(&chrono::FixedOffset::east_opt(7 * 3600).expect("valid Jakarta offset"));
    jakarta.format("%Y-%m-%d").to_string()
}

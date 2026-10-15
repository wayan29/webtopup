pub(super) fn normalize_payload_text(value: Option<&str>) -> String {
    value.unwrap_or_default().trim().to_string()
}

pub(super) fn normalize_phone(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .trim()
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect()
}

pub(super) fn format_date_part(format: &str, day: u32, month: u32, year: i32) -> String {
    let yy = year.rem_euclid(100).to_string();
    match format {
        "DDMMYYYY" => format!("{day:02}{month:02}{year:04}"),
        "MMDDYYYY" => format!("{month:02}{day:02}{year:04}"),
        "DDMMYY" => format!("{day:02}{month:02}{yy:0>2}"),
        "YYMMDD" => format!("{yy:0>2}{month:02}{day:02}"),
        "NONE" => String::new(),
        _ => format!("{year:04}{month:02}{day:02}"),
    }
}

use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
};

pub(super) fn sanitize_product_description(input: &str) -> String {
    let mut builder = ammonia::Builder::default();
    builder
        .tags(HashSet::from([
            "p", "br", "ul", "ol", "li", "strong", "b", "em", "i", "a",
        ]))
        .tag_attributes(HashMap::from([("a", HashSet::from(["href"]))]))
        .generic_attributes(HashSet::new())
        .url_schemes(HashSet::from(["https"]))
        .url_relative(ammonia::UrlRelative::Deny)
        .link_rel(Some("noopener noreferrer"))
        .attribute_filter(|element, attribute, value| {
            if element != "a" || attribute != "href" {
                return Some(Cow::Borrowed(value));
            }
            if value
                .bytes()
                .any(|byte| byte.is_ascii_control() || byte == b'\\')
            {
                return None;
            }
            let parsed = url::Url::parse(value).ok()?;
            if parsed.scheme() == "https"
                && parsed.host_str().is_some()
                && value.starts_with("https://")
            {
                Some(Cow::Borrowed(value))
            } else {
                None
            }
        });
    builder.clean(input).to_string()
}

#[cfg(test)]
mod tests {
    use super::sanitize_product_description as sanitize;

    #[test]
    fn sanitize_product_description_preserves_only_approved_formatting() {
        assert_eq!(
            sanitize("<p><strong>Aman</strong><br><a href='https://example.com'>Link</a></p>"),
            "<p><strong>Aman</strong><br><a href=\"https://example.com\" rel=\"noopener noreferrer\">Link</a></p>"
        );
        assert_eq!(
            sanitize("<p>Teks <b>tebal</b> <em>miring</em> <i>juga</i></p><ul><li>Satu</li></ul><ol><li>Dua</li></ol>"),
            "<p>Teks <b>tebal</b> <em>miring</em> <i>juga</i></p><ul><li>Satu</li></ul><ol><li>Dua</li></ol>"
        );
    }

    #[test]
    fn sanitize_product_description_removes_dangerous_elements() {
        let input = concat!(
            "<script>alert(1)</script><style>body{display:none}</style>",
            "<iframe src='https://example.com'></iframe><svg><script>alert(2)</script></svg>",
            "<form><input value='secret'></form><img src='https://example.com/x'>",
            "<video src='x'></video><audio src='x'></audio><object data='x'></object><embed src='x'>"
        );
        let output = sanitize(input);
        for denied in [
            "script", "style", "iframe", "svg", "form", "input", "img", "video", "audio", "object",
            "embed",
        ] {
            assert!(
                !output.to_ascii_lowercase().contains(&format!("<{denied}")),
                "unexpected {denied} in {output}"
            );
        }
    }

    #[test]
    fn sanitize_product_description_removes_all_unapproved_attributes() {
        assert_eq!(
            sanitize("<p onclick='x' style='color:red' class='x' id='x' data-x='x'>A</p><a href='https://example.com' target='_blank' onclick='x' title='x'>B</a>"),
            "<p>A</p><a href=\"https://example.com\" rel=\"noopener noreferrer\">B</a>"
        );
    }

    #[test]
    fn sanitize_product_description_allows_https_links_only() {
        for href in [
            "javascript:alert(1)",
            "java&#x73;cript:alert(1)",
            "data:text/html,x",
            "http://example.com",
            "//example.com",
            "/relative",
            "relative/path",
            "https:\\example.com",
            "https://exa mple.com",
            "jav\u{0000}ascript:alert(1)",
            "jav\u{0009}ascript:alert(1)",
        ] {
            let output = sanitize(&format!("<a href=\"{href}\">Link</a>"));
            assert!(
                !output.contains("href="),
                "unsafe href survived: {href:?} => {output}"
            );
        }
        assert_eq!(
            sanitize("<a href='https://example.com/path?q=1#ok'>Link</a>"),
            "<a href=\"https://example.com/path?q=1#ok\" rel=\"noopener noreferrer\">Link</a>"
        );
    }

    #[test]
    fn sanitize_product_description_handles_nested_malformed_html() {
        let output = sanitize("<p><a href='javascript:alert(1)'><strong onclick='x'>A</p></a><script><p>B</p></script>");
        assert!(!output.contains("javascript:"));
        assert!(!output.contains("onclick"));
        assert!(!output.contains("<script"));
        assert!(output.contains("<p>"));
        assert!(output.contains("<strong>A</strong>"));
    }
}

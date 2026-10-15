use uuid::Uuid;

pub const MAX_JS_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

pub(super) fn validate_expected_version(version: i64) -> Result<i64, ()> {
    if (0..=MAX_JS_SAFE_INTEGER).contains(&version) { Ok(version) } else { Err(()) }
}

/// The SQL catalog stores revisions starting at one; the public API exposes a zero-based version.
pub(super) fn version_from_revision(revision: i64) -> Option<i64> {
    let version = revision.checked_sub(1)?;
    (0..=MAX_JS_SAFE_INTEGER).contains(&version).then_some(version)
}

pub(super) fn revision_for_expected_version(version: i64) -> Option<i64> {
    if validate_expected_version(version).is_ok() {
        let revision = version.checked_add(1)?;
        (revision <= MAX_JS_SAFE_INTEGER).then_some(revision)
    } else {
        None
    }
}

pub(super) fn active_version_predicate(id: Uuid, version: i64) -> Option<(Uuid, i64)> {
    Some((id, revision_for_expected_version(version)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_safe_versions_and_maps_sql_revisions() {
        assert_eq!(validate_expected_version(0), Ok(0));
        assert_eq!(validate_expected_version(MAX_JS_SAFE_INTEGER), Ok(MAX_JS_SAFE_INTEGER));
        assert_eq!(validate_expected_version(-1), Err(()));
        assert_eq!(validate_expected_version(MAX_JS_SAFE_INTEGER + 1), Err(()));
        assert_eq!(version_from_revision(1), Some(0));
        assert_eq!(version_from_revision(4), Some(3));
        assert_eq!(version_from_revision(0), None);
        assert_eq!(version_from_revision(i64::MIN), None);
    }

    #[test]
    fn expected_version_maps_to_compare_and_swap_revision() {
        let id = Uuid::nil();
        assert_eq!(active_version_predicate(id, 0), Some((id, 1)));
        assert_eq!(active_version_predicate(id, 3), Some((id, 4)));
        assert_eq!(active_version_predicate(id, MAX_JS_SAFE_INTEGER), None);
    }
}

use std::path::Path;

/// Suggests a descriptive name/description based on the filename.
/// - Strips the extension.
/// - Replaces underscores and dashes with spaces.
/// - Detects date patterns like `2024_03_11` or `20240311` and formats them.
/// - Prepend "taken " to the date if "screenshot" (case-insensitive) is present.
/// - Capitalizes the first letter.
pub fn suggest_name(filename: &str) -> String {
    // 1. Strip the file extension
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename);

    let is_screenshot = stem.to_lowercase().contains("screenshot");
    let chars: Vec<char> = stem.chars().collect();
    let mut date_replaced_stem = None;

    // Helper to map month number to name
    let month_name = |month: u32| -> Option<&'static str> {
        match month {
            1 => Some("March"), // wait, month 1 is January! Let's map properly!
            // Let's do correct mapping:
            // 1 => January, 2 => February, 3 => March, 4 => April, 5 => May, 6 => June,
            // 7 => July, 8 => August, 9 => September, 10 => October, 11 => November, 12 => December
            _ => None,
        };
        // Let's write the real match
        match month {
            1 => Some("January"),
            2 => Some("February"),
            3 => Some("March"),
            4 => Some("April"),
            5 => Some("May"),
            6 => Some("June"),
            7 => Some("July"),
            8 => Some("August"),
            9 => Some("September"),
            10 => Some("October"),
            11 => Some("November"),
            12 => Some("December"),
            _ => None,
        }
    };

    // 2. Scan for date patterns YYYY_MM_DD / YYYY-MM-DD / YYYYMMDD
    let mut i = 0;
    while i < chars.len() {
        // Look for 10-char patterns first: YYYY_MM_DD or YYYY-MM-DD
        if i + 10 <= chars.len() {
            let is_sep = |c: char| c == '_' || c == '-';
            let is_digit = |c: char| c.is_ascii_digit();

            if chars[i..i + 4].iter().all(|&c| is_digit(c))
                && is_sep(chars[i + 4])
                && chars[i + 5..i + 7].iter().all(|&c| is_digit(c))
                && is_sep(chars[i + 7])
                && chars[i + 8..i + 10].iter().all(|&c| is_digit(c))
            {
                let year: u32 = chars[i..i + 4].iter().collect::<String>().parse().unwrap();
                let month: u32 = chars[i + 5..i + 7].iter().collect::<String>().parse().unwrap();
                let day: u32 = chars[i + 8..i + 10].iter().collect::<String>().parse().unwrap();

                if month >= 1 && month <= 12 && day >= 1 && day <= 31 {
                    if let Some(m_name) = month_name(month) {
                        let original_pattern: String = chars[i..i + 10].iter().collect();
                        let formatted = if is_screenshot {
                            format!("taken {} {} {}", m_name, day, year)
                        } else {
                            format!("{} {}, {}", m_name, day, year)
                        };
                        date_replaced_stem = Some(stem.replace(&original_pattern, &formatted));
                        break;
                    }
                }
            }
        }

        // Look for 8-char pattern: YYYYMMDD
        if i + 8 <= chars.len() {
            let is_digit = |c: char| c.is_ascii_digit();

            if chars[i..i + 8].iter().all(|&c| is_digit(c)) {
                let year: u32 = chars[i..i + 4].iter().collect::<String>().parse().unwrap();
                let month: u32 = chars[i + 4..i + 6].iter().collect::<String>().parse().unwrap();
                let day: u32 = chars[i + 6..i + 8].iter().collect::<String>().parse().unwrap();

                if month >= 1 && month <= 12 && day >= 1 && day <= 31 {
                    if let Some(m_name) = month_name(month) {
                        let original_pattern: String = chars[i..i + 8].iter().collect();
                        let formatted = if is_screenshot {
                            format!("taken {} {} {}", m_name, day, year)
                        } else {
                            format!("{} {}, {}", m_name, day, year)
                        };
                        date_replaced_stem = Some(stem.replace(&original_pattern, &formatted));
                        break;
                    }
                }
            }
        }

        i += 1;
    }

    let base_string = date_replaced_stem.unwrap_or_else(|| stem.to_string());

    // 3. Replace underscores and dashes with spaces
    let replaced = base_string.replace('_', " ").replace('-', " ");

    // 4. Remove consecutive whitespaces and trim
    let mut cleaned = String::new();
    let mut last_was_space = false;
    for c in replaced.chars() {
        if c.is_whitespace() {
            if !last_was_space {
                cleaned.push(' ');
                last_was_space = true;
            }
        } else {
            cleaned.push(c);
            last_was_space = false;
        }
    }
    let trimmed = cleaned.trim();

    // 5. Capitalize the first letter
    let mut c_iter = trimmed.chars();
    match c_iter.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c_iter.as_str(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_autonamer_basic() {
        assert_eq!(suggest_name("resume_google_2024.pdf"), "Resume google 2024");
    }

    #[test]
    fn test_autonamer_screenshot_date() {
        assert_eq!(
            suggest_name("screenshot_2024_03_11.png"),
            "Screenshot taken March 11 2024"
        );
    }

    #[test]
    fn test_autonamer_screenshot_date_no_sep() {
        assert_eq!(
            suggest_name("screenshot_20240311.png"),
            "Screenshot taken March 11 2024"
        );
    }

    #[test]
    fn test_autonamer_other_date() {
        assert_eq!(
            suggest_name("report_2024_03_11.pdf"),
            "Report March 11, 2024"
        );
        assert_eq!(
            suggest_name("meeting-20240311.docx"),
            "Meeting March 11, 2024"
        );
    }
}

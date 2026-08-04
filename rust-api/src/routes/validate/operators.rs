use super::types::OperatorInfo;

pub fn operators() -> [OperatorInfo; 6] {
    [
        OperatorInfo {
            name: "Telkomsel",
            prefixes: &[
                "0811", "0812", "0813", "0821", "0822", "0823", "0852", "0853", "0851",
            ],
            color: "red",
        },
        OperatorInfo {
            name: "Indosat Ooredoo",
            prefixes: &["0814", "0815", "0816", "0855", "0856", "0857", "0858"],
            color: "yellow",
        },
        OperatorInfo {
            name: "XL Axiata",
            prefixes: &["0859", "0877", "0878", "0817", "0818", "0819"],
            color: "blue",
        },
        OperatorInfo {
            name: "3 (Tri)",
            prefixes: &["0898", "0899", "0895", "0896", "0897"],
            color: "gray",
        },
        OperatorInfo {
            name: "Smartfren",
            prefixes: &[
                "0889", "0881", "0882", "0883", "0886", "0887", "0888", "0884", "0885",
            ],
            color: "purple",
        },
        OperatorInfo {
            name: "Axis",
            prefixes: &["0832", "0833", "0838", "0831"],
            color: "green",
        },
    ]
}

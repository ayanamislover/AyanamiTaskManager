fn main() {
    atm_build_support::embed(atm_build_support::Resource {
        name: "cli",
        description: "AyanamiTaskManager command line",
        original_filename: "atm.exe",
        internal_name: "atm",
    });
}

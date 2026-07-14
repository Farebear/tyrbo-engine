// TYRBO-PATCH: single source of truth for tyrbo branding on the engine
// side. flags/theme.ts builds the default theme from these values; the
// builder UI reads them through the THEME flag. Assets live in
// packages/web/public/tyrbo (copied from the tyrbo product repo,
// packages/ui/assets).
export const tyrboBrand = {
    websiteName: 'Tyrbo',
    // brand accents: #facc15 → #e8873a → #d06a9c → #8b3fb8 (135deg gradient);
    // the purple anchor is the primary interactive color in the dark UI
    primaryColor: '#8b3fb8',
    fullLogoUrl: '/tyrbo/logo-t.png',
    logoIconUrl: '/tyrbo/logo.png',
    favIconUrl: '/tyrbo/fav-icon.png',
}

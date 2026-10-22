// Fixtures commit to throwaway repositories. A developer's global commit.gpgsign would make every such
// commit wait on a passphrase prompt, so disable it for this process and the test files it spawns.
process.env.GIT_CONFIG_COUNT = '1';
process.env.GIT_CONFIG_KEY_0 = 'commit.gpgsign';
process.env.GIT_CONFIG_VALUE_0 = 'false';

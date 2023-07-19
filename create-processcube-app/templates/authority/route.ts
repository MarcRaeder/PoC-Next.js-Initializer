import NextAuth from 'next-auth';

const handler = NextAuth({
  debug: true,
  session: { strategy: 'jwt' },
  providers: [
    {
      id: 'authority',
      name: '5Minds Authority',
      type: 'oauth',
      wellKnown: 'http://authority:11560/.well-known/openid-configuration',
      authorization: {
        params: {
          scope: 'openid email profile',
        },
      },
      idToken: true,
      clientId: 'newportal',
      clientSecret: process.env.NEXTAUTH_SECRET,
      checks: 'pkce',
      profile(profile) {
        return {
          id: profile.sub,
          name: profile.name,
          email: profile.email,
          image: profile.picture,
        };
      },
    },
  ],
});

export { handler as GET, handler as POST };

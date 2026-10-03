"""
Small built-in deny-list of very common passwords (lower-case). It is a
cheap first line of defence, not a complete breach corpus; extend the set or
swap in a larger list later without touching callers. Only entries that would
otherwise pass the minimum length matter (the minimum is >= 8).
"""

COMMON_PASSWORDS: frozenset[str] = frozenset(
    """
    password password1 password12 password123 password1234 passw0rd p@ssw0rd p@ssword pa$$word
    12345678 123456789 1234567890 12345678910 11111111 00000000 87654321 987654321 0987654321
    123123123 123321123 112233445 11223344 1q2w3e4r 1q2w3e4r5t 1qaz2wsx 1qaz@wsx qwertyui
    qwerty123 qwerty1234 qwertyuiop qwertyuiop123 asdfghjk asdfghjkl zxcvbnm1 zxcvbnm123
    qazwsxedc abcd1234 abc12345 abcdefgh abcdefg1 abcd@1234 a1b2c3d4 aaaaaaaa
    iloveyou iloveyou1 iloveyou123 letmein1 letmein123 welcome1 welcome123 welcome12
    admin123 admin1234 administrator adminadmin admin@123 admin12345 root1234 rootroot
    changeme changeme1 changeme123 default1 default123 test1234 test12345 testtest
    guest123 user1234 username username1 login123 monkey123 dragon123 master123
    football football1 baseball baseball1 basketball superman superman1 batman123
    sunshine sunshine1 princess princess1 trustno1 whatever whatever1 shadow123
    michael1 jordan23 jennifer charlie1 daniel123 thomas123 hunter123 hello123 hello1234
    freedom1 starwars starwars1 computer computer1 internet internet1 secret123
    mypassword mypassword1 mypass123 passpass passw0rd1 qweasdzxc qweasd123 q1w2e3r4
    iranian1 tehran123 tehran1234 iran1234 iran12345 persian123 shiraz123 mashhad1
    maintenance maintenance1 equipment elevator1 escalator1 mallmall
    """.split()
)

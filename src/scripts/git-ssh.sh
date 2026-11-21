#!/bin/sh
# Git runs this from site/staging/<attempt>/repo. Fixed relative paths avoid
# OpenSSH's option interpolation on a stack path. Git supplies the SSH argv.
exec /usr/bin/ssh -F /dev/null \
    -o BatchMode=yes -o PreferredAuthentications=publickey \
    -o IdentitiesOnly=yes -o IdentityAgent=none -o CertificateFile=none \
    -i ../../../private/ssh/identity \
    -o StrictHostKeyChecking=yes -o UpdateHostKeys=no \
    -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile=../../../private/ssh/known_hosts \
    -o ClearAllForwardings=yes -o ForwardAgent=no -o ForwardX11=no \
    -o RequestTTY=no -o ControlMaster=no \
    "$@"

#!/usr/bin/env bash
# Shared disposable Docker daemon for the opt-in labs, sourced by a runner.
#
# It creates ONE privileged docker:dind container on the caller's current
# daemon and exposes it through a Unix socket in a private directory. That is
# its own Docker resource namespace, not the isolation of a VM: use it only on
# a development machine or a throwaway VM, never on a server running real
# stacks. Nothing outside that container and the two private directories is
# ever removed, and a failed cleanup is reported and turns into a non-zero exit.
#
# Usage:
#   source scripts/docker-lab/lib.sh
#   LAB_NAME=my-lab-$$ LAB_IMAGE=docker:29.9.0-dind lab_start
#   trap lab_on_exit EXIT
#   ... docker ...              # DOCKER_HOST now points at the lab daemon
#   lab_outer_docker ...        # the daemon that hosts the lab container
#
# Optional: LAB_PUBLISH (one host port spec, e.g. 127.0.0.1:5030:5030) maps a
# port from the lab container, for suites that must reach an inner published
# port from the host. The managed-sites lab probes from inside instead, so the
# gateway keeps its real 127.0.0.1-only binding.

lab_outer_docker() {
    if [ -n "${LAB_OUTER_CONTEXT:-}" ]; then
        env -u DOCKER_HOST DOCKER_CONTEXT="$LAB_OUTER_CONTEXT" docker "$@"
    else
        env -u DOCKER_HOST docker "$@"
    fi
}

lab_start() {
    : "${LAB_NAME:?LAB_NAME is required}"
    LAB_IMAGE="${LAB_IMAGE:-docker:29.9.0-dind}"
    LAB_CONTAINER_ID=""
    LAB_CLEANED=0
    # The lab daemon endpoint is pinned now, before anything repoints DOCKER_*,
    # so creation and removal can never diverge.
    LAB_OUTER_CONTEXT="${DOCKER_CONTEXT-}"
    unset DOCKER_HOST COMPOSE_PROJECT_NAME COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PROFILES

    LAB_DIR="$(mktemp -d /tmp/compose-panel-lab.XXXXXX)"
    # Shared at the same path on both sides, like the real deployment (host path
    # == container path), so the lab daemon can bind-mount it. Not under /tmp:
    # the dind entrypoint mounts a tmpfs over /tmp, hiding the host directory.
    mkdir -p "${HOME:?}/.cache"
    LAB_SHARED="$(mktemp -d "$HOME/.cache/compose-panel-lab-shared.XXXXXX")"
    mkdir -m 700 "$LAB_DIR/socket"

    local args=(-d --name "$LAB_NAME" --privileged)
    if [ -n "${LAB_PUBLISH:-}" ]; then
        args+=(-p "$LAB_PUBLISH")
    fi
    args+=(
        -v "$LAB_DIR/socket:/lab"
        -v "$LAB_SHARED:$LAB_SHARED"
        --entrypoint dind
        "$LAB_IMAGE"
        dockerd -H unix:///lab/docker.sock --label compose-panel-lab=1
    )
    if ! LAB_CONTAINER_ID="$(lab_outer_docker run "${args[@]}")"; then
        LAB_CONTAINER_ID=""
        lab_cleanup || true
        return 1
    fi

    local ready=0
    for _ in $(seq 1 60); do
        if lab_outer_docker exec "$LAB_CONTAINER_ID" test -S /lab/docker.sock 2>/dev/null; then
            ready=1
            break
        fi
        sleep 0.5
    done
    if [ "$ready" -ne 1 ]; then
        echo "The lab daemon did not start:" >&2
        lab_outer_docker logs "$LAB_CONTAINER_ID" 2>&1 | tail -20 >&2
        lab_cleanup || true
        return 1
    fi
    # The directory is private to this user; let this user reach the socket.
    lab_outer_docker exec "$LAB_CONTAINER_ID" chmod 666 /lab/docker.sock

    unset DOCKER_CONTEXT
    export DOCKER_HOST="unix://$LAB_DIR/socket/docker.sock"
    for _ in $(seq 1 40); do docker info >/dev/null 2>&1 && break; sleep 0.5; done
    if ! docker info >/dev/null 2>&1; then
        echo "The lab daemon is not reachable through $DOCKER_HOST" >&2
        lab_cleanup || true
        return 1
    fi
    echo "Lab daemon: $(docker info --format '{{.Name}} {{.ServerVersion}} {{json .Labels}}')"

    # A lab daemon must be empty: no containers, no volumes and no network
    # besides the three built-ins. A leftover resource would belong to someone
    # else, and this script only ever removes what it created.
    local extra_networks
    extra_networks="$(docker network ls --format '{{.Name}}' | while read -r name; do
        case "$name" in bridge | host | none) ;; *) echo "$name" ;; esac
    done)"
    if [ -n "$(docker ps -aq)" ] || [ -n "$(docker volume ls -q)" ] || [ -n "$extra_networks" ]; then
        echo "The lab daemon is not empty; refusing." >&2
        lab_cleanup || true
        return 1
    fi
}

lab_cleanup() {
    # 1 means nothing was started, so there is nothing to remove.
    if [ "${LAB_CLEANED:-1}" = "1" ]; then
        return 0
    fi
    LAB_CLEANED=1
    local failed=0
    if [ -n "${LAB_CONTAINER_ID:-}" ]; then
        if ! lab_outer_docker rm -fv "$LAB_CONTAINER_ID" >/dev/null 2>&1; then
            echo "lab: could not remove the daemon container $LAB_CONTAINER_ID" >&2
            failed=1
        fi
    fi
    if [ -n "${LAB_DIR:-}" ]; then
        case "$LAB_DIR" in
            /tmp/compose-panel-lab.*)
                if ! rm -rf -- "$LAB_DIR"; then
                    echo "lab: could not remove $LAB_DIR" >&2
                    failed=1
                fi
                ;;
            *)
                echo "lab: refusing to remove unexpected directory $LAB_DIR" >&2
                failed=1
                ;;
        esac
    fi
    if [ -n "${LAB_SHARED:-}" ]; then
        case "$LAB_SHARED" in
            "${HOME:?}/.cache/compose-panel-lab-shared."*)
                if ! rm -rf -- "$LAB_SHARED"; then
                    echo "lab: could not remove $LAB_SHARED" >&2
                    failed=1
                fi
                ;;
            *)
                echo "lab: refusing to remove unexpected directory $LAB_SHARED" >&2
                failed=1
                ;;
        esac
    fi
    return "$failed"
}

lab_on_exit() {
    local status=$?
    if ! lab_cleanup; then
        status=1
    fi
    exit "$status"
}

lab_seed_from_cache() {
    local image
    for image in "$@"; do
        if lab_outer_docker image inspect "$image" >/dev/null 2>&1; then
            if lab_outer_docker save "$image" | docker load >/dev/null 2>&1; then
                echo "Seeded from the outer cache: $image"
            fi
        fi
    done
}

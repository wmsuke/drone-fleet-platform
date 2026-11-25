FROM ros@sha256:8eed0a4669bbf43ee331878a4c39bd8ebddea8e3312a58b4fae8edb14526b617
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
COPY docs/experiments/gazebo-selection/prepare.py docs/experiments/gazebo-selection/packages.arm64.tsv /opt/flight/
COPY flight-sim/packages.amd64.tsv /opt/flight/
RUN arch=$(dpkg --print-architecture) && \
    lock="/opt/flight/packages.$arch.tsv" && test -s "$lock" && \
    sed -i 's|^URIs: .*|URIs: https://snapshot.ubuntu.com/ubuntu/20261124T070000Z/|' /etc/apt/sources.list.d/ubuntu.sources && \
    dpkg-query -W | sed -E 's/:(amd64|arm64)\t/\t/' > /tmp/base-packages.tsv && \
    awk 'NR==FNR {base[$1]=$2; next} {sub(/:(amd64|arm64)$/, "", $1)} base[$1]!=$2 {print $1 "=" $2}' \
      /tmp/base-packages.tsv "$lock" > /tmp/packages-to-install && \
    mapfile -t packages < /tmp/packages-to-install && \
    apt-get update -o APT::Update::Error-Mode=any && \
    apt-get install -y --no-install-recommends "${packages[@]}" && \
    dpkg-query -W > /opt/flight/packages.tsv && \
    diff -u <(sed -E 's/:(amd64|arm64)\t/\t/' "$lock" | LC_ALL=C sort) \
      <(sed -E 's/:(amd64|arm64)\t/\t/' /opt/flight/packages.tsv | LC_ALL=C sort) && \
    source /opt/ros/jazzy/setup.bash && test "$(gz sim --versions)" = 8.15.0 && \
    rm -rf /var/lib/apt/lists/* /tmp/base-packages.tsv /tmp/packages-to-install
RUN python3 /opt/flight/prepare.py && \
    echo '207806dd9bd92cf3ab5e4e8a980225adee1b597cb136b105f7939386547925f8  /tmp/flight-probe/probe.sdf' | sha256sum -c - && \
    chmod -R a+rX /tmp/flight-probe
COPY flight-sim/smoke.py flight-sim/observations.py /opt/flight/
ENV PYTHONDONTWRITEBYTECODE=1 RMW_IMPLEMENTATION=rmw_fastrtps_cpp HOME=/tmp ROS_HOME=/tmp/ros-home
USER 10001:10001
ENTRYPOINT ["/bin/bash", "-c", "source /opt/ros/jazzy/setup.bash && exec python3 /opt/flight/smoke.py \"$@\"", "flight-sim"]

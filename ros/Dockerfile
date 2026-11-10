FROM ros@sha256:8eed0a4669bbf43ee331878a4c39bd8ebddea8e3312a58b4fae8edb14526b617
SHELL ["/bin/bash", "-c"]
WORKDIR /workspace
COPY . .
RUN sha256sum -c locks/wheels.sha256 && mkdir /opt/bridge-python && while read -r digest wheel; do python3 -m zipfile -e "$wheel" /opt/bridge-python; done < locks/wheels.sha256
ENV PYTHONPATH=/opt/bridge-python
RUN python3 tools/verify_environment.py && source /opt/ros/jazzy/setup.bash && colcon build --event-handlers console_direct+
RUN cc -shared -fPIC -Wall -Wextra -Werror -o tools/dds_fault.so tools/dds_fault.c -ldl
ENV RMW_IMPLEMENTATION=rmw_fastrtps_cpp ROS_DOMAIN_ID=42 ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST ROS_STATIC_PEERS="" ROS_HOME=/tmp/ros-home ROS_LOG_DIR=/tmp/ros-logs PYTHONDONTWRITEBYTECODE=1
RUN useradd --uid 10001 --no-create-home reference && mkdir -p /data/fleet && chown -R 10001:10001 /workspace /data/fleet
USER 10001:10001
ENTRYPOINT ["/bin/bash", "/workspace/tools/entrypoint.sh"]
CMD ["ros2", "run", "fleet_reference", "serve", "--config", "/workspace/config/reference.json"]

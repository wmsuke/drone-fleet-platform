from setuptools import find_packages, setup

setup(
    name="fleet_bridge", version="0.4.0", packages=find_packages(exclude=["test"]),
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/fleet_bridge"]),
        ("share/fleet_bridge", ["package.xml"]),
    ],
    install_requires=["setuptools"], zip_safe=True,
    maintainer="Fleet Platform", maintainer_email="maintainers@example.invalid",
    description="MQTTとROSの起動・終了境界", license="MIT", tests_require=["pytest"],
    entry_points={"console_scripts": ["run = fleet_bridge.cli:main"]},
)
